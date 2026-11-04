import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "../utils/session";
import { fetchXiaochan } from "../utils/xiaochan";
import { fetchMeituan } from "../utils/meituan";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    if (session.lastSync && Date.now() - session.lastSync < 30_000)
      throw createError({
        statusCode: 429,
        statusMessage: "请等待 30 秒后重试",
      });
    if (
      !session.xiaochanHeaders &&
      session.connections.meituan.state !== "connected"
    )
      throw createError({
        statusCode: 400,
        statusMessage: "请先连接平台账号",
      });
    if (!session.location) throw createError({
      statusCode: 400,
      statusMessage: "请先设置收餐地址",
    });
    session.lastSync = Date.now();
    const errors: string[] = [];
    if (session.xiaochanHeaders) {
      try {
        session.offers.xiaochan = await fetchXiaochan(
          session.xiaochanHeaders,
          session.location,
        );
        session.updatedAt.xiaochan = new Date().toISOString();
        session.connections.xiaochan = {
          state: "configured",
          label: "会话可访问",
          updatedAt: session.updatedAt.xiaochan,
          message: "会话可访问",
        };
      } catch (error: any) {
        errors.push(error.statusMessage || error.message || "小蚕同步失败");
        if (error.statusCode === 401)
          session.connections.xiaochan = {
            state: "expired",
            label: "会话失效",
            message: errors.at(-1),
          };
      }
    }
    if (session.connections.meituan.state === "connected") {
      try {
        session.offers.meituan = await fetchMeituan(id, session.location);
        session.updatedAt.meituan = new Date().toISOString();
      } catch (error: any) {
        errors.push(error.statusMessage || "美团同步失败，请查看官方窗口");
        if (error.statusCode === 401)
          session.connections.meituan = {
            state: "expired",
            label: "登录已失效",
            message: errors.at(-1),
          };
      }
    }
    await saveSession(id, session);
    return {
      data: publicSession(session),
      errors,
      message: errors.length
        ? "部分平台同步失败"
        : "同步完成",
    };
  });
});
