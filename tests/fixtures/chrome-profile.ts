import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface TestChromeCookie {
  domain?: string;
  name: string;
  value?: string;
  encrypted?: Buffer;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number;
}

export async function writeChromeProfile(directory: string, cookies: TestChromeCookie[], profile = "Default", version = 24) {
  await mkdir(join(directory, profile), { recursive: true });
  const path = join(directory, profile, "Cookies");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,
      path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,is_persistent INTEGER,samesite INTEGER);
      DELETE FROM cookies;`);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('version',?)").run(String(version));
    const insert = db.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const cookie of cookies) insert.run(cookie.domain || ".meituan.com", cookie.name,
      cookie.value || "", cookie.encrypted || Buffer.alloc(0), cookie.path || "/",
      cookie.expires ? (cookie.expires + 11644473600) * 1_000_000 : 0,
      cookie.secure === false ? 0 : 1, cookie.httpOnly ? 1 : 0, cookie.expires ? 1 : 0, cookie.sameSite ?? 1);
  } finally { db.close(); }
  return path;
}
