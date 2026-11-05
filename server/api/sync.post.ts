import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "../utils/session";
import { fetchXiaochan, isXiaochanGuest } from "../utils/xiaochan";
import { fetchMeituan } from "../utils/meituan";
import { fetchWaimai } from "../utils/waimai";
import { COMPARISON_RADIUS_METERS } from "../../shared/utils/scope";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body?.provider !== undefined && !["xiaochan", "waimai"].includes(body.provider))
    throw createError({ statusCode: 400, statusMessage: "请选择霸王餐平台" });
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const syncXiaochan = body?.provider !== "waimai" && !!session.xiaochanHeaders;
    const syncWaimai = body?.provider !== "xiaochan" &&
      session.waimaiToken !== undefined && session.connections.waimai.state === "configured";
    const syncMeituan = session.connections.meituan.state === "connected" ||
      (session.connections.meituan.state === "configured" && !!session.meituanStorage);
    if (session.lastSync && Date.now() - session.lastSync < 30_000)
      throw createError({
        statusCode: 429,
        statusMessage: "请等待 30 秒后重试",
      });
    if (
      !syncXiaochan && !syncWaimai &&
      !syncMeituan
    )
      throw createError({
        statusCode: 400,
        statusMessage: "请先连接平台账号",
      });
    if (!session.location) throw createError({
      statusCode: 400,
      statusMessage: "请先设置收餐地址",
    });
    if (syncWaimai && !session.location.cityName)
      throw createError({ statusCode: 400, statusMessage: "请填写收餐地址的城市名称" });
    session.lastSync = Date.now();
    const errors: string[] = [];
    const scope = { radiusMeters: COMPARISON_RADIUS_METERS };
    if (syncXiaochan) {
      try {
        session.offers.xiaochan = await fetchXiaochan(
          session.xiaochanHeaders!,
          session.location,
          scope,
        );
        session.updatedAt.xiaochan = new Date().toISOString();
        const label = isXiaochanGuest(session.xiaochanHeaders!)
          ? "访客访问" : "会话可访问";
        session.connections.xiaochan = {
          state: "configured",
          label,
          updatedAt: session.updatedAt.xiaochan,
          message: label,
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
    if (syncWaimai) {
      try {
        session.offers.waimai = await fetchWaimai(session.waimaiToken!, session.location, fetch, scope);
        session.updatedAt.waimai = new Date().toISOString();
        session.connections.waimai = {
          state: "configured",
          label: session.waimaiToken ? "会话可访问" : "访客访问",
          updatedAt: session.updatedAt.waimai,
        };
      } catch (error: any) {
        errors.push(error.statusMessage || "歪麦同步失败");
        if (error.statusCode === 401)
          session.connections.waimai = { state: "expired", label: "会话失效", message: errors.at(-1) };
      }
    }
    if (syncMeituan) {
      try {
        session.offers.meituan = await fetchMeituan(id, session.location, scope);
        session.updatedAt.meituan = new Date().toISOString();
        if (session.connections.meituan.state === "configured")
          session.connections.meituan = { ...session.connections.meituan, state: "connected", message: "连接成功", updatedAt: session.updatedAt.meituan };
      } catch (error: any) {
        errors.push(error.statusMessage || "美团同步失败，请查看登录页面");
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
