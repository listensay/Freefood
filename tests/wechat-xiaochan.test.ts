import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import {
  decodeWeChatXiaochanStorage, readWeChatXiaochanLogin,
  verifyWeChatXiaochanLogin, XIAOCHAN_MINI_APP_ID,
} from "../server/utils/wechat-xiaochan";
import type { xiaochanRpc } from "../server/utils/xiaochan-rpc";

const now = 1793923200000;
const user = (overrides: Record<string, any> = {}) => ({
  silkId: 123456789,
  userInfo: { silk_id: 123456789, user_id: 6789, phone: "13800000000" },
  wechat_user_info: { user_id: 6789 },
  token: { access_token: "test-wechat-access-token", refresh_token: "test-wechat-refresh-token", created: 1793923100, expiry: 2000000000 },
  ...overrides,
});

function varint(value: number) {
  const bytes: number[] = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(low | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function entry(key: string | Buffer, value: unknown, dataType = "String") {
  const k = typeof key === "string" ? Buffer.from(key) : key;
  const json = Buffer.from(JSON.stringify({ data: value, dataType }));
  const wrapped = Buffer.concat([varint(json.length), json]);
  return Buffer.concat([varint(k.length), k, varint(wrapped.length), wrapped]);
}

const deleted = (key: string) => Buffer.concat([varint(Buffer.byteLength(key)), Buffer.from(key), Buffer.from([0])]);

function fixture(options: { entries?: Buffer[]; payload?: Buffer; baseUrl?: string; user?: any; key?: Buffer } = {}) {
  const plain = options.payload ?? Buffer.concat([Buffer.alloc(4), ...(options.entries ?? [
    entry("store_user", JSON.stringify(options.user ?? user())),
    entry("store_system", { model: "MacBook", brand: "Apple" }, "Object"),
    entry("baseUrl", options.baseUrl ?? "https://gw.xiaocantech.com"),
    entry("sessionId", "fixture-wechat-session-id"),
  ])]);
  const key = options.key ?? Buffer.concat([Buffer.from("w" + XIAOCHAN_MINI_APP_ID.slice(2).split("").filter((_, i) => !(i % 2)).join("")), Buffer.alloc(7)]);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cfb", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const main = Buffer.alloc(4 + encrypted.length + 32);
  main.writeUInt32LE(encrypted.length); encrypted.copy(main, 4);
  const metadata = Buffer.alloc(40);
  metadata.writeUInt32LE(crc32(encrypted)); metadata.writeUInt32LE(4, 4);
  metadata.writeUInt32LE(1, 8); iv.copy(metadata, 12);
  metadata.writeUInt32LE(encrypted.length, 28);
  return { main, metadata };
}

async function store(root: string, profile: string, data: ReturnType<typeof fixture>, appId = XIAOCHAN_MINI_APP_ID) {
  const directory = join(root, profile, "applet/local", appId, "usrmmkvstorage0");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, appId), data.main);
  await writeFile(join(directory, appId + ".crc"), data.metadata);
  return directory;
}

test("Computer WeChat decoder reads only the selected login fields from genuine CFB MMKV bytes", () => {
  const source = fixture();
  const original = { main: Buffer.from(source.main), metadata: Buffer.from(source.metadata) };
  const result = decodeWeChatXiaochanStorage(source.main, source.metadata, now);
  assert.deepEqual(result.account, {
    silkId: "123456789", userId: "6789", accessToken: "test-wechat-access-token",
    refreshToken: "test-wechat-refresh-token", expiresAt: 2000000000000,
    platform: "mini", version: "3.22.2.83", model: "MacBook Apple", sessionId: "fixture-wechat-session-id",
  });
  assert.deepEqual(source, original);
  assert.equal((result as any).userInfo, undefined);
});

test("Computer WeChat decoder retains the last selected value and honors deleted login records", () => {
  const entries = [entry("store_user", JSON.stringify(user({ silkId: 1 }))), entry("unused", "not collected"),
    entry("store_user", JSON.stringify(user())), entry("baseUrl", "https://gw.xiaocantech.com")];
  const result = fixture({ entries });
  assert.equal(decodeWeChatXiaochanStorage(result.main, result.metadata, now).account.silkId, "123456789");
  const removed = fixture({ entries: [...entries, deleted("store_user")] });
  assert.throws(() => decodeWeChatXiaochanStorage(removed.main, removed.metadata, now), { statusCode: 401 });
});

test("Computer WeChat decoder rejects checksums, unsupported metadata, size mismatch and wrong encryption keys", () => {
  const mutations: Array<(data: ReturnType<typeof fixture>) => void> = [
    data => { data.main[8] ^= 1; },
    data => { data.metadata.writeUInt32LE(3, 4); },
    data => { data.metadata.writeUInt32LE(0xffffffff, 28); },
    data => { data.main.writeUInt32LE(4); },
    data => { data.metadata = data.metadata.subarray(0, 39); },
    data => { data.main = Buffer.alloc(4 * 1024 * 1024 + 1); },
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data);
    assert.throws(() => decodeWeChatXiaochanStorage(data.main, data.metadata, now), { statusCode: 422 });
  }
  const wrong = fixture({ key: Buffer.alloc(16, 1) });
  assert.throws(() => decodeWeChatXiaochanStorage(wrong.main, wrong.metadata, now), { statusCode: 422 });
});

test("Computer WeChat decoder strictly validates UTF-8, wrapper lengths and the complete payload", () => {
  const valid = [entry("store_user", JSON.stringify(user())), entry("baseUrl", "https://gw.xiaocantech.com")];
  const malformed = [
    Buffer.concat([Buffer.alloc(4), ...valid, Buffer.from([0x80])]),
    Buffer.concat([Buffer.alloc(4), entry(Buffer.from([0xff]), "bad"), ...valid]),
    Buffer.concat([Buffer.alloc(4), entry("store_user", "not JSON"), valid[1]]),
    Buffer.concat([Buffer.alloc(4), varint(10), Buffer.from("short")]),
    Buffer.concat([Buffer.alloc(4), varint(7), Buffer.from("baseUrl"), varint(1), Buffer.from([50])]),
  ];
  for (const payload of malformed) {
    const data = fixture({ payload });
    assert.throws(() => decodeWeChatXiaochanStorage(data.main, data.metadata, now), { statusCode: 422 });
  }
});

test("Computer WeChat decoder binds local identity and refuses expired or malformed credentials", () => {
  const changes = [
    { silkId: 0 }, { silkId: 1234567890123 },
    { userInfo: { silk_id: 1, user_id: 6789 } },
    { wechat_user_info: { user_id: 9999 } },
    { token: { access_token: "bad\r\nheader", expiry: 2000000000 } },
    { token: { access_token: "valid", expiry: now / 1000 } },
  ];
  for (const change of changes) {
    const data = fixture({ user: user(change) });
    assert.throws(() => decodeWeChatXiaochanStorage(data.main, data.metadata, now), { statusCode: 401 });
  }
});

test("Computer WeChat decoder does not accept another service or a malformed service URL", () => {
  for (const baseUrl of ["https://evil.example", "https://gw.xiaocantech.com.evil.example", "not a URL",
    "http://gw.xiaocantech.com", "ftp://gw.xiaocantech.com", "https://user:pass@gw.xiaocantech.com", "https://gw.xiaocantech.com:444"]) {
    const data = fixture({ baseUrl });
    assert.throws(() => decodeWeChatXiaochanStorage(data.main, data.metadata, now), { statusCode: 422 }, baseUrl);
  }
});

test("Computer WeChat reader is limited to Xiaochan, rejects symbolic links, and leaves source files unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "food-wechat-test-"));
  try {
    await store(root, "a".repeat(32), fixture(), "wx5762f23d920ad9e5");
    await assert.rejects(readWeChatXiaochanLogin(root), { statusCode: 404 });
    const dir = await store(root, "a".repeat(32), fixture());
    const before = await readFile(join(dir, XIAOCHAN_MINI_APP_ID));
    assert.equal((await readWeChatXiaochanLogin(root)).account.userId, "6789");
    assert.deepEqual(await readFile(join(dir, XIAOCHAN_MINI_APP_ID)), before);
    await rm(join(dir, XIAOCHAN_MINI_APP_ID));
    await symlink(join(dir, XIAOCHAN_MINI_APP_ID + ".crc"), join(dir, XIAOCHAN_MINI_APP_ID));
    await assert.rejects(readWeChatXiaochanLogin(root), { statusCode: 422 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Computer WeChat reader chooses the freshest same identity and rejects multiple account identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "food-wechat-multiple-"));
  try {
    await store(root, "a".repeat(32), fixture());
    await store(root, "b".repeat(32), fixture({ user: user({ token: { access_token: "fresh-token", expiry: 2100000000 } }) }));
    assert.equal((await readWeChatXiaochanLogin(root)).account.accessToken, "fresh-token");
    await store(root, "c".repeat(32), fixture({ user: user({ userInfo: { silk_id: 123456789, user_id: 1111 }, wechat_user_info: { user_id: 1111 } }) }));
    await assert.rejects(readWeChatXiaochanLogin(root), { statusCode: 409 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Computer WeChat reader refuses redirected roots and ambiguous excessive profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "food-wechat-roots-"));
  try {
    const source = join(root, "profiles");
    await store(source, "a".repeat(32), fixture());
    const redirected = join(root, "redirected");
    await symlink(source, redirected);
    await assert.rejects(readWeChatXiaochanLogin(redirected), { statusCode: 422 });
    const many = join(root, "many");
    for (let i = 0; i < 21; i++) await mkdir(join(many, i.toString(16).padStart(32, "0")), { recursive: true });
    await assert.rejects(readWeChatXiaochanLogin(many), { statusCode: 409 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Computer WeChat session verification requires matching official identities and uses the mini-program contract", async () => {
  const data = fixture();
  const login = decodeWeChatXiaochanStorage(data.main, data.metadata, now);
  const result = await verifyWeChatXiaochanLogin(login, (async request => {
    assert.equal(request.serverName, "Silkworm");
    assert.equal(request.methodName, "SilkwormService.GetClientUserInfo");
    assert.equal(request.headers["x-platform"], "mini");
    assert.equal(request.headers["x-app-sr"], "20");
    assert.deepEqual(request.body, { silk_id: 123456789, user_id: 6789, app_id: 20 });
    return { status: { code: 0 }, user_info: {
      silk_id: 123456789, user_id: 6789, phone: "13800000000", nickname: "测试账号",
      avatar: "https://images.example.com/avatar.png", private_field: "private-upstream-data",
    } };
  }) as typeof xiaochanRpc);
  assert.equal(result.label, "已登录");
  assert.deepEqual(result.profile, {
    userId: "6789", nickname: "测试账号", phone: "138****0000", avatar: "https://images.example.com/avatar.png",
  });
  assert.equal(JSON.stringify(result.profile).includes("private"), false);
  for (const userInfo of [{}, { silk_id: 1, user_id: 6789 }, { silk_id: 123456789, user_id: 1 }, { silk_id: 123456789, user_id: 6789, if_logoff: true }])
    await assert.rejects(verifyWeChatXiaochanLogin(login, (async () => ({ status: { code: 0 }, user_info: userInfo })) as typeof xiaochanRpc), { statusCode: 401 });
});

test("Computer WeChat profile omits malformed optional fields without accepting a different identity", async () => {
  const data = fixture();
  const login = decodeWeChatXiaochanStorage(data.main, data.metadata, now);
  const result = await verifyWeChatXiaochanLogin(login, (async () => ({
    status: { code: 0 }, user_info: {
      silk_id: 123456789, user_id: 6789, nickname: "invalid\nname", phone: "invalid phone",
      avatar: "javascript:alert(1)", access_token: "private-upstream-token",
    },
  })) as typeof xiaochanRpc);
  assert.deepEqual(result.profile, { userId: "6789" });
  assert.equal(JSON.stringify(result.profile).includes(login.account.accessToken), false);
});
