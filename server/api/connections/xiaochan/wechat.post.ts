import { readWeChatXiaochanLogin, verifyWeChatXiaochanLogin } from "../../../utils/wechat-xiaochan";
import { loadSession, saveSession, publicSession, sessionId, withSessionLock } from "../../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body !== undefined && body !== null &&
    (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
    throw createError({ statusCode: 400, statusMessage: "请使用连接电脑微信" });
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const result = await verifyWeChatXiaochanLogin(await readWeChatXiaochanLogin());
    const changed = session.xiaochanAccount?.userId !== result.account.userId ||
      session.xiaochanAccount?.silkId !== result.account.silkId;
    const next = {
      ...session,
      xiaochanAccount: result.account,
      connections: { ...session.connections, xiaochan: {
        state: "connected" as const, label: result.label,
        updatedAt: new Date().toISOString(), profile: result.profile,
      } },
      offers: changed ? { ...session.offers, xiaochan: [] } : session.offers,
      updatedAt: { ...session.updatedAt },
    };
    if (changed) {
      delete next.xiaochanEnrollments;
      delete next.xiaochanSchedules;
      delete next.updatedAt.xiaochan;
    }
    await saveSession(id, next);
    return publicSession(next);
  });
});
