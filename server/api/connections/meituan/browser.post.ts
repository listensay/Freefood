import { defineEventHandler, readBody, createError } from "h3";
import { readChromeMeituanLogins } from "../../../utils/chrome-meituan";
import { closeMeituan, verifyMeituanBrowserStorage } from "../../../utils/meituan";
import { loadSession, saveSession, publicSession, sessionId, withSessionLock, samePlatformAccount } from "../../../utils/session";

const connecting = new Set<string>();

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body !== undefined && body !== null &&
    (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
    throw createError({ statusCode: 400, statusMessage: "请使用连接 Chrome" });
  if (connecting.has(id)) throw createError({ statusCode: 409, statusMessage: "正在连接 Chrome" });
  connecting.add(id);
  try {
    const snapshot = structuredClone(await loadSession(id));
    const logins = await readChromeMeituanLogins();
    const verified = new Map<string, Awaited<ReturnType<typeof verifyMeituanBrowserStorage>>>();
    let failure: unknown;
    for (const login of logins) {
      try {
        const result = await verifyMeituanBrowserStorage(login, snapshot.location);
        verified.set(result.accountId, result);
      } catch (error) { failure = error; }
    }
    if (verified.size > 1)
      throw createError({ statusCode: 409, statusMessage: "检测到多个美团账号，请仅保留需要连接的 Chrome 账号" });
    if (!verified.size) throw failure || createError({ statusCode: 401, statusMessage: "请先在 Chrome 的试吃官页面中登录" });
    const result = [...verified.values()][0]!;
    return await withSessionLock(id, async () => {
      const session = await loadSession(id);
      if (!samePlatformAccount(session, snapshot, "meituan"))
        throw createError({ statusCode: 409, statusMessage: "美团账号已更新，请重新连接" });
      const changed = session.meituanAccountId
        ? session.meituanAccountId !== result.accountId : session.connections.meituan.label !== result.label;
      await closeMeituan(id);
      session.meituanStorage = result.storage;
      session.meituanAccountId = result.accountId;
      session.connections.meituan = { state: "connected", label: result.label, updatedAt: new Date().toISOString() };
      if (changed) {
        session.offers.meituan = [];
        delete session.updatedAt.meituan;
      }
      await saveSession(id, session);
      return publicSession(session);
    });
  } finally {
    connecting.delete(id);
  }
});
