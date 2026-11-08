import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SessionDatabase } from "../server/utils/session-database";

const id = "a".repeat(64), otherId = "b".repeat(64);
const snapshot = { location: { label: "测试地址" }, connections: { xiaochan: { state: "connected" } },
  offers: { xiaochan: [], waimai: [], meituan: [] }, updatedAt: {},
  xiaochanAccount: { accessToken: "private-database-canary", silkId: "123", userId: "456" },
  xiaochanSchedules: { "xiaochan:42": { state: "scheduled", advanceOrder: true, runAt: "2026-11-07T12:30:00+08:00" } },
  xiaochanEnrollments: { "xiaochan:43": { state: "unknown", advanceOrder: true } },
};
async function fixture(run: (directory: string, key: Buffer) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "food-sqlite-"));
  try { await run(directory, randomBytes(32)); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function legacy(directory: string, id: string, value: any, key: Buffer) {
  await writeFile(join(directory, "session.key"), key);
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  await writeFile(join(directory, id + ".enc"), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
}

test("SQLite encrypts complete sessions and retains durable uncertain enrollment and early scheduling state", async () => fixture(async (directory, key) => {
  let db = await SessionDatabase.open(directory, async () => key);
  db.write(id, snapshot); assert.deepEqual(db.read(id), snapshot);
  db.selectDesktop(id); db.close();
  const bytes = await readFile(join(directory, "food.sqlite3"));
  assert.equal(bytes.subarray(0, 15).toString(), "SQLite format 3");
  assert.equal(bytes.includes(Buffer.from("private-database-canary")), false);
  db = await SessionDatabase.open(directory, async () => key);
  assert.deepEqual(db.read(id), snapshot); assert.equal(db.desktopId(), id); db.close();
}));

test("Wrong keys and swapped encrypted rows cannot disclose or replace another session", async () => fixture(async (directory, key) => {
  const db = await SessionDatabase.open(directory, async () => key); db.write(id, snapshot); db.close();
  await assert.rejects(SessionDatabase.open(directory, async () => randomBytes(32)), /本地数据读取失败/);
  const sql = new DatabaseSync(join(directory, "food.sqlite3"));
  sql.prepare("INSERT INTO sessions SELECT ?,payload,updated_at FROM sessions WHERE id=?").run(otherId, id); sql.close();
  const reopened = await SessionDatabase.open(directory, async () => key);
  assert.deepEqual(reopened.read(id), snapshot);
  assert.throws(() => reopened.read(otherId), /本地数据读取失败/); reopened.close();
}));

test("Legacy import is lossless, idempotent, selects a sole profile and never rewrites source files", async () => fixture(async (directory, key) => {
  await legacy(directory, id, snapshot, randomBytes(32));
  const before = await readFile(join(directory, id + ".enc"));
  const db = await SessionDatabase.open(directory, async () => key);
  assert.equal((await db.importLegacy(directory)).imported, 1);
  assert.equal(db.desktopId(), id); assert.deepEqual(db.read(id), snapshot);
  const updated = { ...snapshot, location: { label: "新地址" } }; db.write(id, updated);
  assert.equal((await db.importLegacy(directory)).imported, 0);
  assert.deepEqual(db.read(id), updated); assert.deepEqual(await readFile(join(directory, id + ".enc")), before);
  db.close();
}));

test("A corrupt legacy file rolls the whole import back and leaves existing SQLite data unchanged", async () => fixture(async (directory, key) => {
  await legacy(directory, id, snapshot, key); await writeFile(join(directory, otherId + ".enc"), Buffer.from("damaged"));
  const db = await SessionDatabase.open(directory, async () => key);
  const existing = "c".repeat(64); db.write(existing, { ...snapshot, location: null });
  await assert.rejects(db.importLegacy(directory), /旧数据导入失败/);
  assert.deepEqual(db.ids(), [existing]); assert.equal(db.read(existing).location, null); db.close();
}));

test("Multiple legacy browser profiles remain separate and never silently select or merge identities", async () => fixture(async (directory, key) => {
  await legacy(directory, id, snapshot, key);
  await legacy(directory, otherId, { ...snapshot, location: { label: "另一地址" } }, key);
  const db = await SessionDatabase.open(directory, async () => key); await db.importLegacy(directory);
  assert.notEqual(db.desktopId(), id); assert.notEqual(db.desktopId(), otherId);
  db.selectDesktop(otherId); assert.equal(db.read(db.desktopId()).location.label, "另一地址");
  assert.equal(db.read(id).location.label, "测试地址"); db.close();
}));

test("Symlinked legacy records and newer database schemas fail closed", async () => fixture(async (directory, key) => {
  await legacy(directory, id, snapshot, key); await symlink(join(directory, id + ".enc"), join(directory, otherId + ".enc"));
  const db = await SessionDatabase.open(directory, async () => key);
  await assert.rejects(db.importLegacy(directory), /旧数据导入失败/); assert.deepEqual(db.ids(), []); db.close();
  const sql = new DatabaseSync(join(directory, "food.sqlite3")); sql.exec("PRAGMA user_version=9"); sql.close();
  await assert.rejects(SessionDatabase.open(directory, async () => key), /数据库版本较新/);
}));

test("A failed SQLite write leaves the previous snapshot intact", async () => fixture(async (directory, key) => {
  const db = await SessionDatabase.open(directory, async () => key); db.write(id, snapshot);
  const sql = new DatabaseSync(join(directory, "food.sqlite3"));
  sql.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  assert.throws(() => db.write(id, { ...snapshot, location: null }), /test write failure/);
  assert.deepEqual(db.read(id), snapshot); sql.close(); db.close();
}));

test("The service lease prevents duplicate schedulers and is released on normal shutdown", async () => fixture(async (directory, key) => {
  const first = await SessionDatabase.open(directory, async () => key), second = await SessionDatabase.open(directory, async () => key);
  first.acquireRuntimeLock(); assert.throws(() => second.acquireRuntimeLock(), /已有应用正在运行/);
  first.close(); second.acquireRuntimeLock(); second.close();
}));
