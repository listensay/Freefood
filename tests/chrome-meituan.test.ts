import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChromeMeituanLogins } from "../server/utils/chrome-meituan";
import { writeChromeProfile } from "./fixtures/chrome-profile";
import { passportRequestIssue } from "../server/utils/meituan-login";

const testPassword = "fixture-keychain-password";
const aesKey = pbkdf2Sync(testPassword, "saltysalt", 1003, 16, "sha1");
const encryptedCookie = (value: string, domain = ".meituan.com", version = 24) => {
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 32));
  const plain = version >= 24 ? Buffer.concat([createHash("sha256").update(domain).digest(), Buffer.from(value)]) : Buffer.from(value);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
};

test("Chrome connection decrypts host-bound login records and preserves cookie metadata without changing the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  const password = Buffer.from(testPassword);
  try {
    const path = await writeChromeProfile(directory, [
      { name: "token", encrypted: encryptedCookie("private-test-token"), httpOnly: true },
      { name: "uuid", value: "test-uuid", sameSite: 2, expires: Date.now() / 1000 + 3600 },
      { name: "token", domain: "evil.example", encrypted: Buffer.from("v20-not-a-meituan-cookie") },
      { name: "expired", encrypted: Buffer.from("invalid"), expires: Date.now() / 1000 - 100 },
    ]);
    const before = await readFile(path);
    const [login] = await readChromeMeituanLogins({ directory, password: async () => password });
    assert.equal(login?.cookies.length, 2);
    assert.equal(login?.cookies[0]?.value, "private-test-token");
    assert.equal(login?.cookies[0]?.httpOnly, true);
    assert.equal(login?.cookies[1]?.sameSite, "Strict");
    assert.deepEqual(login?.origins, []);
    assert.deepEqual(await readFile(path), before);
    assert.ok(password.every(byte => byte === 0));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome connection reads older records and avoids keychain access when login is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  try {
    await writeChromeProfile(directory, [{ name: "token", encrypted: encryptedCookie("older-token", ".meituan.com", 23) }], "Default", 23);
    const [login] = await readChromeMeituanLogins({ directory, password: async () => Buffer.from(testPassword) });
    assert.equal(login?.cookies[0]?.value, "older-token");
    await writeChromeProfile(directory, [{ name: "token", value: "expired-token", expires: Date.now() / 1000 - 100 }]);
    await assert.rejects(readChromeMeituanLogins({ directory, password: async () => { assert.fail("Must not request keychain without an account"); } }), { statusCode: 401 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome connection reads activity sessions without a passport token and preserves both encrypted cookies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  try {
    const path = await writeChromeProfile(directory, [
      { name: "wm_ado_ge_x", encrypted: encryptedCookie("activity-session"), expires: Date.now() / 1000 + 3600 },
      { name: "wm_ado_ge_e_k", encrypted: encryptedCookie("activity-key"), expires: Date.now() / 1000 + 3600 },
      { name: "uuid", value: "activity-uuid" },
    ]);
    const before = await readFile(path);
    const [login] = await readChromeMeituanLogins({ directory, password: async () => Buffer.from(testPassword) });
    assert.deepEqual(login?.cookies.map(cookie => [cookie.name, cookie.value]), [
      ["wm_ado_ge_x", "activity-session"], ["wm_ado_ge_e_k", "activity-key"], ["uuid", "activity-uuid"],
    ]);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome connection rejects incomplete, expired, empty and foreign activity sessions without keychain access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  try {
    for (const cookies of [
      [{ name: "wm_ado_ge_x", value: "session" }],
      [{ name: "wm_ado_ge_e_k", value: "key" }],
      [{ name: "wm_ado_ge_x", value: "session", expires: Date.now() / 1000 - 100 }, { name: "wm_ado_ge_e_k", value: "key" }],
      [{ name: "wm_ado_ge_x", value: "session" }, { name: "wm_ado_ge_e_k", value: "key", expires: Date.now() / 1000 - 100 }],
      [{ name: "wm_ado_ge_x", value: "" }, { name: "wm_ado_ge_e_k", value: "key" }],
      [{ name: "wm_ado_ge_x", value: "session", domain: "evil.example" }, { name: "wm_ado_ge_e_k", value: "key", domain: "evil.example" }],
      [{ name: "uuid", value: "visitor" }, { name: "logan_session_token", value: "telemetry" }],
    ]) {
      await writeChromeProfile(directory, cookies);
      await assert.rejects(readChromeMeituanLogins({ directory, password: async () => { assert.fail("Must not request keychain without login credentials"); } }), { statusCode: 401 });
    }
    await writeChromeProfile(directory, [
      { name: "wm_ado_ge_x", encrypted: encryptedCookie("") },
      { name: "wm_ado_ge_e_k", encrypted: encryptedCookie("key") },
    ]);
    assert.deepEqual(await readChromeMeituanLogins({ directory, password: async () => Buffer.from(testPassword) }), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome connection deduplicates complete activity credentials without merging different sessions or keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  try {
    const cookies = [{ name: "wm_ado_ge_x", value: "session" }, { name: "wm_ado_ge_e_k", value: "key" }];
    await writeChromeProfile(directory, cookies);
    await writeChromeProfile(directory, [...cookies].reverse(), "Profile 1");
    assert.equal((await readChromeMeituanLogins({ directory })).length, 1);
    await writeChromeProfile(directory, [{ name: "wm_ado_ge_x", value: "other-session" }, cookies[1]!], "Profile 1");
    assert.equal((await readChromeMeituanLogins({ directory })).length, 2);
    await writeChromeProfile(directory, [cookies[0]!, { name: "wm_ado_ge_e_k", value: "other-key" }], "Profile 1");
    assert.equal((await readChromeMeituanLogins({ directory })).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome connection rejects wrong keys, swapped hosts and unsupported encryption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  try {
    for (const encrypted of [encryptedCookie("token", "evil.example"), Buffer.from("v20-unsupported")]) {
      await writeChromeProfile(directory, [{ name: "token", encrypted }]);
      await assert.rejects(readChromeMeituanLogins({ directory, password: async () => Buffer.from(testPassword) }), { statusCode: 422 });
    }
    await writeChromeProfile(directory, [{ name: "token", encrypted: encryptedCookie("token") }]);
    await assert.rejects(readChromeMeituanLogins({ directory, password: async () => Buffer.from("wrong-password") }), { statusCode: 422 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Chrome connection deduplicates the same account across profiles and refuses redirected cookie files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "food-chrome-"));
  try {
    const cookies = [{ name: "token", value: "same-token" }];
    await writeChromeProfile(directory, cookies);
    const path = await writeChromeProfile(directory, cookies, "Profile 1");
    assert.equal((await readChromeMeituanLogins({ directory })).length, 1);
    await rm(join(directory, "Default", "Cookies"));
    await symlink(path, join(directory, "Default", "Cookies"));
    await rm(join(directory, "Profile 1"), { recursive: true });
    await assert.rejects(readChromeMeituanLogins({ directory }), { statusCode: 422 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("official login refusals and challenges are classified without exposing private response fields", () => {
  assert.equal(passportRequestIssue(403), "rejected");
  assert.equal(passportRequestIssue(429), "rejected");
  assert.equal(passportRequestIssue(502), "network");
  assert.equal(
    passportRequestIssue(200, {
      error: {
        code: 123,
        message: "请求异常,拒绝操作",
        mobile: "private-phone",
      },
    }),
    "rejected",
  );
  assert.equal(
    passportRequestIssue(200, { error: { request_code: "private-challenge" } }),
    "verification",
  );
  assert.equal(
    passportRequestIssue(200, { error: { message: "验证码错误" } }),
    undefined,
  );
  assert.equal(
    passportRequestIssue(200, { user: { id: 1, token: "secret" } }),
    undefined,
  );
});
