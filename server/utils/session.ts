import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { H3Event } from "h3";
import {
  createError,
  getCookie,
  setCookie,
  getRequestURL,
} from "h3";
import type { DashboardData } from "../../shared/types";
import { providers } from "../../shared/types";
import { assertRequestAccess } from "./request-access";

export interface LocalSession extends DashboardData {
  xiaochanHeaders?: Record<string, string>;
  waimaiToken?: string;
  meituanStorage?: unknown;
  lastSync?: number;
}

const directory = resolve(process.env.FOOD_DATA_DIR || ".data/food");
let keyPromise: Promise<Buffer> | undefined;
const sessions = new Map<string, LocalSession>();
const locks = new Map<string, Promise<unknown>>();

async function encryptionKey(): Promise<Buffer> {
  return (keyPromise ??= (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, "session.key");
    try {
      return await readFile(path);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      const key = randomBytes(32);
      try {
        await writeFile(path, key, { flag: "wx", mode: 0o600 });
        return key;
      } catch (error: any) {
        if (error.code === "EEXIST") return readFile(path);
        throw error;
      }
    }
  })());
}

export function assertLocalRequest(event: H3Event) {
  assertRequestAccess(event, import.meta.dev === true);
}

export function sessionId(event: H3Event): string {
  assertLocalRequest(event);
  let id = getCookie(event, "food-session");
  if (!id || !/^[a-f0-9]{64}$/.test(id)) {
    id = randomBytes(32).toString("hex");
    setCookie(event, "food-session", id, {
      httpOnly: true,
      sameSite: "strict",
      secure: getRequestURL(event, { xForwardedProto: false }).protocol === "https:",
      path: "/",
      maxAge: 30 * 86400,
    });
  }
  return id;
}

export function emptySession(): LocalSession {
  return {
    location: null,
    connections: {
      xiaochan: { state: "disconnected", label: "未连接" },
      waimai: { state: "disconnected", label: "未连接" },
      meituan: { state: "disconnected", label: "未登录" },
    },
    offers: { xiaochan: [], waimai: [], meituan: [] },
    updatedAt: {},
  };
}

export async function loadSession(id: string): Promise<LocalSession> {
  if (sessions.has(id)) return sessions.get(id)!;
  const key = await encryptionKey();
  let session: LocalSession;
  try {
    const encrypted = await readFile(resolve(directory, `${id}.enc`));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      encrypted.subarray(0, 12),
    );
    decipher.setAuthTag(encrypted.subarray(12, 28));
    session = JSON.parse(
      Buffer.concat([
        decipher.update(encrypted.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  } catch (error: any) {
    if (error.code !== "ENOENT")
      throw createError({
        statusCode: 500,
        statusMessage: "本地会话读取失败，请检查数据目录和密钥",
      });
    session = emptySession();
  }
  let changed = false;
  for (const provider of providers) {
    if (!session.connections[provider] || !session.offers[provider]) {
      session.connections[provider] ||= emptySession().connections[provider];
      session.offers[provider] ||= [];
      changed = true;
    }
    const offers = session.offers[provider].filter(
      offer => offer.source === "live" || offer.source === "import",
    );
    if (offers.length !== session.offers[provider].length) {
      session.offers[provider] = offers;
      if (!offers.length) delete session.updatedAt[provider];
      changed = true;
    }
  }
  if (changed) await saveSession(id, session);
  sessions.set(id, session);
  return session;
}

export async function saveSession(id: string, session: LocalSession) {
  const key = await encryptionKey(),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(session)),
    cipher.final(),
  ]);
  const path = resolve(directory, `${id}.enc`),
    temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), {
    mode: 0o600,
  });
  await rename(temporary, path);
  sessions.set(id, session);
}

export function withSessionLock<T>(
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(id, current);
  void current
    .finally(() => {
      if (locks.get(id) === current) locks.delete(id);
    })
    .catch(() => {});
  return current;
}

export function publicSession(session: LocalSession): DashboardData {
  return {
    location: session.location,
    connections: session.connections,
    offers: session.offers,
    updatedAt: session.updatedAt,
  };
}
