import { createDecipheriv } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { createError } from "h3";

const MAX_STORAGE_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface AppStorage {
  appId: string;
  name: string;
}

interface AppLoginReader<T> extends AppStorage {
  decode: (main: Buffer, metadata: Buffer) => T;
  identity: (login: T) => string;
  freshness?: (login: T) => number;
}

const formatError = (app: AppStorage) => createError({
  statusCode: 422, statusMessage: `微信${app.name}存储格式无法识别，请更新连接工具`,
});
const updatingError = (app: AppStorage) => createError({
  statusCode: 409, statusMessage: `${app.name}正在更新登录状态，请重新连接`,
});

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  for (let shift = 0; shift <= 49 && offset < bytes.length; shift += 7) {
    const byte = bytes[offset++]!;
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128) && Number.isSafeInteger(value)) return [value, offset];
  }
  throw new Error("Invalid storage varint");
}

function parsePayload(plain: Buffer, selected: ReadonlySet<string>): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  let offset = 4, count = 0;
  while (offset < plain.length) {
    if (++count > 10_000) throw new Error("Storage entry limit exceeded");
    const [keyLength, keyStart] = readVarint(plain, offset);
    if (!keyLength || keyLength > 1024 || keyStart + keyLength > plain.length)
      throw new Error("Invalid storage key");
    const key = decoder.decode(plain.subarray(keyStart, keyStart + keyLength));
    if (key.includes("\0")) throw new Error("Invalid storage key");
    const [valueLength, valueStart] = readVarint(plain, keyStart + keyLength);
    if (valueStart + valueLength > plain.length) throw new Error("Invalid storage value");
    offset = valueStart + valueLength;
    if (!selected.has(key)) continue;
    if (!valueLength) {
      entries.delete(key);
      continue;
    }
    const raw = plain.subarray(valueStart, offset);
    const [wrappedLength, wrappedStart] = readVarint(raw, 0);
    if (wrappedLength !== raw.length - wrappedStart) throw new Error("Invalid storage wrapper size");
    const wrapper = JSON.parse(decoder.decode(raw.subarray(wrappedStart)));
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper) ||
      !Object.hasOwn(wrapper, "data") || !["Object", "String"].includes(wrapper.dataType))
      throw new Error("Invalid storage wrapper");
    entries.set(key, wrapper.data);
  }
  if (offset !== plain.length) throw new Error("Incomplete storage payload");
  return entries;
}

export function decodeWeChatStorage(
  main: Buffer,
  metadata: Buffer,
  app: AppStorage,
  keys: readonly string[],
): Map<string, unknown> {
  let plain: Buffer | undefined;
  const key = Buffer.alloc(16);
  try {
    if (!/^wx[a-f0-9]{16}$/.test(app.appId) || main.length < 8 || main.length > MAX_STORAGE_BYTES ||
      metadata.length < 40 || metadata.length > 64_000)
      throw new Error("Invalid storage size");
    const size = metadata.readUInt32LE(28);
    if (metadata.readUInt32LE(4) !== 4 || size < 4 || size > main.length - 4 || main.readUInt32LE(0) !== size)
      throw new Error("Invalid storage metadata");
    const encrypted = main.subarray(4, 4 + size);
    if (crc32(encrypted) !== metadata.readUInt32LE(0)) throw new Error("Storage checksum mismatch");
    Buffer.from("w" + [...app.appId.slice(2)].filter((_, index) => index % 2 === 0).join("")).copy(key);
    const decipher = createDecipheriv("aes-128-cfb", key, metadata.subarray(12, 28));
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return parsePayload(plain, new Set(keys));
  } catch {
    throw formatError(app);
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

async function regularFile(path: string, maxBytes: number, app: AppStorage): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === "ELOOP") throw formatError(app);
    throw error;
  });
  let bytes: Buffer | undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw formatError(app);
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw updatingError(app);
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw updatingError(app);
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await file.close();
  }
}

async function readStableStorage<T>(directory: string, app: AppLoginReader<T>): Promise<{ login: T; modifiedAt: number }> {
  const path = join(directory, app.appId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const buffers: Buffer[] = [];
    try {
      const before = await lstat(path);
      const read = async (file: string, limit: number) => {
        const bytes = await regularFile(file, limit, app);
        buffers.push(bytes);
        return bytes;
      };
      const main = await read(path, MAX_STORAGE_BYTES);
      const metadata = await read(path + ".crc", 64_000);
      const checkMain = await read(path, MAX_STORAGE_BYTES);
      const checkMetadata = await read(path + ".crc", 64_000);
      const after = await lstat(path);
      if (main.equals(checkMain) && metadata.equals(checkMetadata) &&
        before.mtimeMs === after.mtimeMs && before.size === after.size)
        return { login: app.decode(main, metadata), modifiedAt: after.mtimeMs };
    } finally {
      for (const bytes of buffers) bytes.fill(0);
    }
  }
  throw updatingError(app);
}

export async function readWeChatAppLogin<T>(
  app: AppLoginReader<T>,
  directory = process.env.FOOD_WECHAT_DATA_DIR || join(homedir(),
    "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users"),
): Promise<T> {
  if (!/^wx[a-f0-9]{16}$/.test(app.appId)) throw formatError(app);
  if (process.platform !== "darwin" && !process.env.FOOD_WECHAT_DATA_DIR)
    throw createError({ statusCode: 501, statusMessage: "电脑微信连接当前支持 macOS" });
  let users;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw createError({ statusCode: 422, statusMessage: `微信${app.name}存储目录无法识别` });
    users = await readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error.statusCode) throw error;
    throw createError({
      statusCode: error.code === "EACCES" || error.code === "EPERM" ? 403 : 404,
      statusMessage: error.code === "EACCES" || error.code === "EPERM"
        ? "无法读取电脑微信，请检查文件访问权限" : `请先在电脑微信中打开${app.name}小程序`,
    });
  }
  const profiles = users.filter(user => user.isDirectory() && /^[a-f0-9]{32}$/.test(user.name));
  if (profiles.length > 20)
    throw createError({ statusCode: 409, statusMessage: "微信账号过多，请选择需要连接的账号" });
  const logins = new Map<string, { login: T; modifiedAt: number }>();
  let failure: any;
  for (const user of profiles) {
    const local = join(directory, user.name, "applet/local", app.appId);
    try {
      for (const path of [join(directory, user.name), join(directory, user.name, "applet"),
        join(directory, user.name, "applet/local"), local, join(local, "usrmmkvstorage0")]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw formatError(app);
      }
      const current = await readStableStorage(join(local, "usrmmkvstorage0"), app);
      const identity = app.identity(current.login), previous = logins.get(identity);
      if (!previous || (app.freshness
        ? app.freshness(current.login) > app.freshness(previous.login)
        : current.modifiedAt > previous.modifiedAt)) logins.set(identity, current);
    } catch (error: any) {
      if (error.code === "ENOENT") continue;
      failure = error;
    }
  }
  if (logins.size > 1) throw createError({
    statusCode: 409, statusMessage: `检测到多个${app.name}账号，请仅保留需要连接的微信账号`,
  });
  if (!logins.size) {
    if (failure?.statusCode) throw failure;
    if (failure?.code === "EACCES" || failure?.code === "EPERM")
      throw createError({ statusCode: 403, statusMessage: "无法读取电脑微信，请检查文件访问权限" });
    throw createError({ statusCode: 404, statusMessage: `请先在电脑微信中打开并登录${app.name}小程序` });
  }
  return [...logins.values()][0]!.login;
}
