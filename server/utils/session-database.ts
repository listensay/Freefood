import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createError } from "h3";
import { sessionEncryptionKey } from "./session-key";

const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
const storageError = () => createError({ statusCode: 500, statusMessage: "本地数据读取失败，请检查数据库和密钥" });
const legacyError = () => createError({ statusCode: 422, statusMessage: "旧数据导入失败，请检查数据目录和密钥" });
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}
async function regular(path: string, directory = false, maxBytes = Infinity) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.size > maxBytes)) throw legacyError();
}

export class SessionDatabase {
  private lease?: string;
  private constructor(readonly directory: string, private db: DatabaseSync, private key: Buffer) {}
  static async open(directory: string, keyProvider = sessionEncryptionKey) {
    directory = resolve(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "food.sqlite3");
    const present = await exists(path);
    if (present) await regular(path);
    const key = await keyProvider(directory, present);
    if (key.length !== 32) throw storageError();
    const db = new DatabaseSync(path, { timeout: 5000 });
    const store = new SessionDatabase(directory, db, Buffer.from(key));
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (version > 1) throw createError({ statusCode: 500, statusMessage: "数据库版本较新，请更新应用" });
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
          PRAGMA user_version=1;`);
        const check = store.meta("key_check");
        if (check) {
          if (store.decode("key_check", Buffer.from(check, "base64")) !== "freefood") throw storageError();
        } else store.setMeta("key_check", store.encode("key_check", "freefood").toString("base64"));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      await chmod(path, 0o600);
      return store;
    } catch (error) { store.close(); throw error; }
  }
  private encode(id: string, value: unknown): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
  }
  private decode(id: string, value: Uint8Array): any {
    try {
      const bytes = Buffer.from(value);
      if (bytes[0] !== 1 || bytes.length < 30) throw storageError();
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(13, 29));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString());
    } catch { throw storageError(); }
  }
  read(id: string): any | undefined {
    if (!validId(id)) throw storageError();
    const row = this.db.prepare("SELECT payload FROM sessions WHERE id = ?").get(id);
    return row ? this.decode(id, row.payload as Uint8Array) : undefined;
  }
  write(id: string, value: unknown) {
    if (!validId(id)) throw storageError();
    const payload = this.encode(id, value);
    this.db.prepare(`INSERT INTO sessions(id,payload,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`).run(id, payload, Date.now());
  }
  ids(): string[] {
    return this.db.prepare("SELECT id FROM sessions ORDER BY id").all().map(row => String(row.id));
  }
  private meta(key: string) { return this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value as string | undefined; }
  private setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  desktopId(): string {
    let id = this.meta("desktop_session");
    if (!id) { id = randomBytes(32).toString("hex"); this.setMeta("desktop_session", id); }
    return id;
  }
  selectDesktop(id: string) {
    if (!validId(id) || !this.read(id)) throw createError({ statusCode: 404, statusMessage: "未找到本地数据" });
    this.setMeta("desktop_session", id);
  }
  async importLegacy(directory: string): Promise<{ imported: number; ids: string[] }> {
    directory = resolve(directory);
    if (!(await exists(directory))) return { imported: 0, ids: [] };
    await regular(directory, true);
    const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.enc$/.test(name));
    const pending = names.filter(name => !this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(name.slice(0, -4)));
    if (!pending.length) return { imported: 0, ids: names.map(name => name.slice(0, -4)) };
    let key: Buffer | undefined;
    const decoded: Array<{ id: string; value: any }> = [];
    try {
      await regular(join(directory, "session.key"), false, 32);
      key = await readFile(join(directory, "session.key"));
      if (key.length !== 32) throw legacyError();
      for (const name of pending) {
        await regular(join(directory, name), false, 64 * 1024 * 1024);
        const encrypted = await readFile(join(directory, name));
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString());
        if (!value || typeof value !== "object" || !value.connections || !value.offers || typeof value.updatedAt !== "object") throw legacyError();
        decoded.push({ id: name.slice(0, -4), value });
      }
    } catch { throw legacyError(); } finally { key?.fill(0); }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { id, value } of decoded) this.write(id, value);
      // Select a single imported profile only when the desktop has no saved data of its own.
      const current = this.meta("desktop_session");
      if (names.length === 1 && (!current || !this.read(current))) this.setMeta("desktop_session", names[0]!.slice(0, -4));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { imported: decoded.length, ids: names.map(name => name.slice(0, -4)) };
  }
  acquireRuntimeLock() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const saved = this.meta("runtime_lease");
      if (saved) {
        const { pid } = JSON.parse(saved);
        let alive = true;
        try { process.kill(pid, 0); } catch (error: any) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw createError({ statusCode: 409, statusMessage: "该数据目录已有应用正在运行" });
      }
      this.lease = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString("hex") });
      this.setMeta("runtime_lease", this.lease); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() {
    if (this.lease) this.db.prepare("DELETE FROM metadata WHERE key='runtime_lease' AND value=?").run(this.lease);
    this.db.close(); this.key.fill(0);
  }
}

const directory = resolve(process.env.FOOD_DATA_DIR || ".data/food");
let pending: Promise<SessionDatabase> | undefined;
let current: SessionDatabase | undefined;
export function sessionDatabase(): Promise<SessionDatabase> {
  return pending ||= SessionDatabase.open(directory).then(async db => {
    try {
      await db.importLegacy(directory);
      if (process.env.FOOD_LEGACY_DATA_DIR && resolve(process.env.FOOD_LEGACY_DATA_DIR) !== directory)
        await db.importLegacy(process.env.FOOD_LEGACY_DATA_DIR);
      current = db;
      return db;
    } catch (error) { db.close(); throw error; }
  });
}
export function desktopSessionId() {
  if (!current) throw createError({ statusCode: 503, statusMessage: "本地服务正在启动" });
  return current.desktopId();
}
export function closeSessionDatabase() { current?.close(); current = undefined; pending = undefined; }
