import { readBody, createError, type H3Event } from "h3";
import type { BawangcanProvider } from "../../shared/types";
import { verifyWeChatXiaochanLogin } from "./wechat-xiaochan";
import { verifyWaimaiAccount } from "./waimai";
import { loadSession, saveSession, publicSession, sessionId, withSessionLock, samePlatformAccount } from "./session";

export async function refreshAccountProfile(event: H3Event, provider: BawangcanProvider) {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body !== undefined && body !== null &&
    (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
    throw createError({ statusCode: 400, statusMessage: "请求格式错误" });
  const snapshot = structuredClone(await loadSession(id));
  if (snapshot.connections[provider].state !== "connected" ||
    !(provider === "xiaochan" ? snapshot.xiaochanAccount : snapshot.waimaiAccount))
    throw createError({ statusCode: 401, statusMessage: "请先登录平台账号" });
  try {
    const profile = provider === "xiaochan"
      ? (await verifyWeChatXiaochanLogin({ account: snapshot.xiaochanAccount! })).profile
      : await verifyWaimaiAccount(snapshot.waimaiAccount!);
    return withSessionLock(id, async () => {
      const session = await loadSession(id);
      if (samePlatformAccount(session, snapshot, provider) && session.connections[provider].state === "connected") {
        session.connections[provider] = {
          ...session.connections[provider], label: "已登录", profile,
        };
        await saveSession(id, session);
      }
      return publicSession(session);
    });
  } catch (error: any) {
    if (error.statusCode === 401) await withSessionLock(id, async () => {
      const session = await loadSession(id);
      if (samePlatformAccount(session, snapshot, provider) && session.connections[provider].state === "connected") {
        session.connections[provider] = {
          ...session.connections[provider], state: "expired", label: "登录已失效",
          message: error.statusMessage,
        };
        await saveSession(id, session);
      }
    });
    throw error;
  }
}
