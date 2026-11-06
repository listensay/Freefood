import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import {
  decodeWeChatWaimaiStorage, readWeChatWaimaiLogin, verifyWeChatWaimaiLogin, WAIMAI_MINI_APP_ID,
} from "../server/utils/wechat-waimai";

const userId = "20260101000000-abcdef1234_user";
const uid = "123456789123456789";
const token = "private-test-waimai-token";
const user = (changes: Record<string, unknown> = {}) => ({
  userId, uid, userToken: token, application: "overbear_one", status: false,
  nickName: "本地缓存昵称", phoneNumber: "13800000000", ...changes,
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

function entry(key: string, value: unknown, dataType = "String") {
  const json = Buffer.from(JSON.stringify({ data: value, dataType }));
  const wrapped = Buffer.concat([varint(json.length), json]);
  return Buffer.concat([varint(Buffer.byteLength(key)), Buffer.from(key), varint(wrapped.length), wrapped]);
}

function fixture(options: { user?: unknown; token?: unknown; entries?: Buffer[]; appId?: string } = {}) {
  const plain = Buffer.concat([Buffer.alloc(4), ...(options.entries ?? [
    entry("value", JSON.stringify(options.user ?? user()), "Object"),
    entry("token", options.token ?? token), entry("unused", "not collected"),
  ])]);
  const key = Buffer.alloc(16);
  Buffer.from("w" + [...(options.appId ?? WAIMAI_MINI_APP_ID).slice(2)].filter((_, i) => !(i % 2)).join("")).copy(key);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cfb", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const main = Buffer.alloc(4 + encrypted.length + 32);
  main.writeUInt32LE(encrypted.length); encrypted.copy(main, 4);
  const metadata = Buffer.alloc(40);
  metadata.writeUInt32LE(crc32(encrypted)); metadata.writeUInt32LE(4, 4);
  metadata.writeUInt32LE(1, 8); iv.copy(metadata, 12); metadata.writeUInt32LE(encrypted.length, 28);
  return { main, metadata };
}

async function store(root: string, profile: string, data: ReturnType<typeof fixture>, appId = WAIMAI_MINI_APP_ID) {
  const directory = join(root, profile, "applet/local", appId, "usrmmkvstorage0");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, appId), data.main);
  await writeFile(join(directory, appId + ".crc"), data.metadata);
  return directory;
}

test("Waimai WeChat decoder binds the stored token and user identity without returning cached profile data", () => {
  for (const entries of [
    [entry("value", JSON.stringify(user()), "Object"), entry("token", token)],
    [entry("value", user(), "Object"), entry("token", token)],
  ]) {
    const source = fixture({ entries });
    const original = { main: Buffer.from(source.main), metadata: Buffer.from(source.metadata) };
    assert.deepEqual(decodeWeChatWaimaiStorage(source.main, source.metadata), { account: { userId, uid, token } });
    assert.deepEqual(source, original);
  }
});

test("Waimai WeChat decoder refuses mismatched tokens, missing users and another application", () => {
  for (const changes of [
    { userId: "" }, { userId: "bad\nidentity" }, { userId: 123 }, { uid: "" }, { uid: "bad\nidentity" },
    { userToken: "another-token" }, { application: "overbear_fifteen" },
  ]) {
    const source = fixture({ user: user(changes) });
    assert.throws(() => decodeWeChatWaimaiStorage(source.main, source.metadata), { statusCode: 401 });
  }
  for (const value of ["", "bad\r\nheader", "x".repeat(16_001)]) {
    const source = fixture({ token: value, user: user({ userToken: value }) });
    assert.throws(() => decodeWeChatWaimaiStorage(source.main, source.metadata), { statusCode: 401 });
  }
  const malformed = fixture({ entries: [entry("value", "invalid JSON", "Object"), entry("token", token)] });
  assert.throws(() => decodeWeChatWaimaiStorage(malformed.main, malformed.metadata), { statusCode: 422 });
});

test("Waimai WeChat decoder honors updates and deletes and rejects invalid checksums or another app key", () => {
  const updates = [entry("value", JSON.stringify(user()), "Object"), entry("token", "old-token"), entry("token", token)];
  const source = fixture({ entries: updates });
  assert.equal(decodeWeChatWaimaiStorage(source.main, source.metadata).account.token, token);
  const deleted = fixture({ entries: [...updates, Buffer.concat([varint(5), Buffer.from("token"), Buffer.from([0])])] });
  assert.throws(() => decodeWeChatWaimaiStorage(deleted.main, deleted.metadata), { statusCode: 401 });
  source.main[8] ^= 1;
  assert.throws(() => decodeWeChatWaimaiStorage(source.main, source.metadata), { statusCode: 422 });
  const other = fixture({ appId: "wx52ae177248081591" });
  assert.throws(() => decodeWeChatWaimaiStorage(other.main, other.metadata), { statusCode: 422 });
});

test("Waimai WeChat reader selects only Waimai storage and refuses redirected files or roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "food-wechat-waimai-"));
  try {
    await store(root, "a".repeat(32), fixture(), "wx52ae177248081591");
    await assert.rejects(readWeChatWaimaiLogin(root), { statusCode: 404 });
    const directory = await store(root, "a".repeat(32), fixture());
    const path = join(directory, WAIMAI_MINI_APP_ID), before = await readFile(path);
    assert.deepEqual((await readWeChatWaimaiLogin(root)).account, { userId, uid, token });
    assert.deepEqual(await readFile(path), before);
    const redirected = root + "-link";
    await symlink(root, redirected);
    try { await assert.rejects(readWeChatWaimaiLogin(redirected), { statusCode: 422 }); }
    finally { await rm(redirected); }
    await rm(path); await symlink(path + ".crc", path);
    await assert.rejects(readWeChatWaimaiLogin(root), { statusCode: 422 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Waimai WeChat reader chooses the most recently updated matching identity and rejects multiple identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "food-wechat-waimai-many-"));
  try {
    const old = await store(root, "a".repeat(32), fixture());
    await utimes(join(old, WAIMAI_MINI_APP_ID), 1, 1);
    await store(root, "b".repeat(32), fixture({ user: user({ userToken: "new-token" }), token: "new-token" }));
    assert.equal((await readWeChatWaimaiLogin(root)).account.token, "new-token");
    await store(root, "c".repeat(32), fixture({ user: user({ uid: "another-user" }) }));
    await assert.rejects(readWeChatWaimaiLogin(root), { statusCode: 409 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Waimai WeChat login must verify the same official user identity and propagate rejected or uncertain outcomes", async () => {
  const login = { account: { userId, uid, token } };
  const result = await verifyWeChatWaimaiLogin(login, async account => {
    assert.deepEqual(account, login.account);
    return { userId: uid, nickname: "官方昵称", phone: "138****0000" };
  });
  assert.equal(result.label, "已登录");
  assert.equal(result.profile.nickname, "官方昵称");
  await assert.rejects(verifyWeChatWaimaiLogin(login, async () => ({ userId: "another-user" })), { statusCode: 401 });
  for (const statusCode of [401, 502]) await assert.rejects(verifyWeChatWaimaiLogin(login, async () => {
    throw Object.assign(new Error("verification failed"), { statusCode });
  }), { statusCode });
});
