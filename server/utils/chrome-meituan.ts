import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createError } from "h3";
import type { BrowserContextOptions } from "playwright-core";

export type MeituanBrowserStorage = Exclude<BrowserContextOptions["storageState"], string | undefined>;
const domains = [".meituan.com", "meituan.com", "offsiteact.meituan.com", ".offsiteact.meituan.com"];
const execute = promisify(execFile);
const activitySessionCookies = ["wm_ado_ge_x", "wm_ado_ge_e_k"];

function loginCookies<T extends { name: string }>(cookies: T[]): T[] {
  // The activity page can use its own session pair without a passport token.
  // These are candidates only; the official identity endpoint still verifies them.
  const credentials = cookies.filter(cookie => cookie.name === "token" || activitySessionCookies.includes(cookie.name));
  return credentials.some(cookie => cookie.name === "token") ||
    activitySessionCookies.every(name => credentials.some(cookie => cookie.name === name)) ? credentials : [];
}

interface ChromeCookie {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  is_persistent: number;
  samesite: number;
}

function cookieError() {
  return createError({ statusCode: 422, statusMessage: "Chrome 登录状态无法读取，请更新连接工具" });
}

async function chromePassword(): Promise<Buffer> {
  try {
    const { stdout } = await execute("/usr/bin/security", [
      "find-generic-password", "-s", "Chrome Safe Storage", "-w",
    ], { encoding: "buffer", timeout: 60_000, maxBuffer: 4096 });
    if (!stdout.length) throw new Error("Missing Chrome key");
    const end = stdout.at(-1) === 10 ? stdout.length - 1 : stdout.length;
    const password = Buffer.from(stdout.subarray(0, end));
    stdout.fill(0);
    return password;
  } catch {
    throw createError({ statusCode: 403, statusMessage: "请允许钥匙串读取 Chrome 登录状态后重试" });
  }
}

export function decodeChromeCookie(row: ChromeCookie, key: Buffer, version: number): string {
  if (row.value) return row.value;
  const bytes = Buffer.from(row.encrypted_value);
  if (bytes.subarray(0, 3).toString() !== "v10" || bytes.length < 19 || (bytes.length - 3) % 16)
    throw cookieError();
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
    if (version >= 24) {
      const digest = createHash("sha256").update(row.host_key).digest();
      if (plain.length < 32 || !digest.equals(plain.subarray(0, 32))) throw cookieError();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plain.subarray(version >= 24 ? 32 : 0));
  } catch {
    throw cookieError();
  } finally {
    plain?.fill(0);
  }
}

async function regular(path: string, directory: boolean) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw cookieError();
  if (!directory && stat.size > 256 * 1024 * 1024) throw cookieError();
}

export async function readChromeMeituanLogins(options: {
  directory?: string;
  password?: () => Promise<Buffer>;
  now?: number;
} = {}): Promise<MeituanBrowserStorage[]> {
  if (process.platform !== "darwin" && !options.directory && !process.env.FOOD_CHROME_DATA_DIR)
    throw createError({ statusCode: 501, statusMessage: "Chrome 连接当前支持 macOS" });
  const directory = options.directory || process.env.FOOD_CHROME_DATA_DIR ||
    join(homedir(), "Library/Application Support/Google/Chrome");
  let profiles: string[];
  try {
    await regular(directory, true);
    profiles = (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isDirectory() && /^(Default|Profile \d+)$/.test(file.name)).map(file => file.name);
  } catch (error: any) {
    if (error.statusCode) throw error;
    throw createError({ statusCode: 404, statusMessage: "请先在 Chrome 中打开并登录试吃官页面" });
  }
  if (profiles.length > 30) throw createError({ statusCode: 409, statusMessage: "Chrome 账号过多，请选择需要连接的账号" });
  const { DatabaseSync } = await import("node:sqlite");
  const candidates: { rows: ChromeCookie[]; version: number }[] = [];
  let failure: unknown;
  for (const profile of profiles) {
    let database: InstanceType<typeof DatabaseSync> | undefined;
    try {
      await regular(join(directory, profile), true);
      const path = join(directory, profile, "Cookies");
      await regular(path, false);
      for (const suffix of ["-wal", "-shm"]) {
        try { await regular(path + suffix, false); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
      database = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
      const version = Number(database.prepare("SELECT value FROM meta WHERE key='version'").get()?.value);
      if (!Number.isSafeInteger(version) || version < 1 || version > 24) throw cookieError();
      const rows = database.prepare(`SELECT host_key,name,value,encrypted_value,path,CAST(expires_utc AS REAL) AS expires_utc,
        is_secure,is_httponly,is_persistent,samesite FROM cookies
        WHERE host_key IN (?,?,?,?) LIMIT 201`).all(...domains) as unknown as ChromeCookie[];
      const now = (options.now ?? Date.now()) / 1000;
      const current = rows.filter(row => !row.is_persistent || row.expires_utc / 1_000_000 - 11644473600 > now);
      if (current.length > 200) throw cookieError();
      if (loginCookies(current.filter(row => row.value || row.encrypted_value.length)).length)
        candidates.push({ rows: current, version });
    } catch (error: any) {
      if (error.code !== "ENOENT") failure = error;
    } finally {
      database?.close();
    }
  }
  if (!candidates.length) {
    if (failure) throw cookieError();
    throw createError({ statusCode: 401, statusMessage: "请先在 Chrome 的试吃官页面中登录" });
  }
  const encrypted = candidates.some(candidate => candidate.rows.some(row => !row.value));
  const password = encrypted ? await (options.password || chromePassword)() : Buffer.alloc(0);
  const key = encrypted ? pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1") : Buffer.alloc(16);
  password.fill(0);
  try {
    const seen = new Set<string>();
    return candidates.flatMap(({ rows, version }) => {
      const cookies = rows.map(row => ({
        name: row.name, value: decodeChromeCookie(row, key, version), domain: row.host_key, path: row.path,
        expires: row.is_persistent ? row.expires_utc / 1_000_000 - 11644473600 : -1,
        httpOnly: !!row.is_httponly, secure: !!row.is_secure,
        sameSite: row.samesite === 2 ? "Strict" as const : row.samesite === 0 && row.is_secure ? "None" as const : "Lax" as const,
      })).filter(cookie => cookie.value && cookie.path.startsWith("/") &&
        /^[!#$%&'*+\-.^_`|~A-Za-z0-9]{1,200}$/.test(cookie.name) &&
        cookie.value.length <= 16_000 && !/[\u0000-\u001f\u007f]/.test(cookie.value));
      const credentials = loginCookies(cookies);
      if (!credentials.length) return [];
      const identity = JSON.stringify(credentials.map(cookie => [cookie.name, cookie.domain, cookie.path, cookie.value]).sort());
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [{ cookies, origins: [] }];
    });
  } finally {
    key.fill(0);
  }
}
