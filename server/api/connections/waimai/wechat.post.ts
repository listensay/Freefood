import { defineEventHandler, readBody, createError } from "h3";
import { readWeChatWaimaiLogin } from "../../../utils/wechat-waimai";
import { verifyWaimaiAccount } from "../../../utils/waimai";
import { loadSession, saveSession, publicSession, sessionId, withSessionLock } from "../../../utils/session";
import { armWaimaiSchedules } from "../../../utils/waimai-schedules";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body !== undefined && body !== null &&
    (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
    throw createError({ statusCode: 400, statusMessage: "请使用连接电脑微信" });
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const { account } = await readWeChatWaimaiLogin();
    const profile = await verifyWaimaiAccount(account);
    const changed = session.waimaiAccount?.uid !== account.uid;
    const next = {
      ...session,
      waimaiAccount: account,
      connections: { ...session.connections, waimai: {
        state: "connected" as const, label: "已登录",
        updatedAt: new Date().toISOString(), profile,
      } },
      offers: changed ? { ...session.offers, waimai: [] } : session.offers,
      updatedAt: { ...session.updatedAt },
    };
    if (changed) {
      delete next.waimaiEnrollments;
      delete next.waimaiSchedules;
      delete next.updatedAt.waimai;
    }
    if (!changed && session.waimaiAccount?.userId !== account.userId && next.waimaiSchedules) {
      next.waimaiSchedules = structuredClone(next.waimaiSchedules);
      for (const schedule of Object.values(next.waimaiSchedules)) {
        if (schedule.accountId === `${account.uid}:${session.waimaiAccount?.userId}`)
          schedule.accountId = `${account.uid}:${account.userId}`;
      }
    }
    await saveSession(id, next);
    armWaimaiSchedules(id, next);
    return publicSession(next);
  });
});
