import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
  samePlatformAccount,
} from "../utils/session";
import { fetchXiaochan } from "../utils/xiaochan";
import { fetchMeituan } from "../utils/meituan";
import { fetchWaimai } from "../utils/waimai";
import type { Offer, Provider } from "../../shared/types";
import { COMPARISON_RADIUS_METERS } from "../../shared/utils/scope";
import { applyXiaochanEnrollmentUpdates, fetchXiaochanEnrollmentUpdates } from "../utils/xiaochan-enrollment";

const syncingSessions = new Set<string>();

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body?.provider !== undefined && !["xiaochan", "waimai"].includes(body.provider))
    throw createError({ statusCode: 400, statusMessage: "请选择霸王餐平台" });
  const { snapshot, targets } = await withSessionLock(id, async () => {
    const session = await loadSession(id);
    if (syncingSessions.has(id) || (session.lastSync && Date.now() - session.lastSync < 30_000))
      throw createError({ statusCode: 429, statusMessage: "请等待 30 秒后重试" });
    const targets: Provider[] = [];
    if (body?.provider !== "waimai" && session.xiaochanAccount && session.connections.xiaochan.state === "connected")
      targets.push("xiaochan");
    if (body?.provider !== "xiaochan" && session.waimaiAccount && session.connections.waimai.state === "connected")
      targets.push("waimai");
    if (session.connections.meituan.state === "connected" ||
      (session.connections.meituan.state === "configured" && session.meituanStorage)) targets.push("meituan");
    if (!targets.length)
      throw createError({ statusCode: 400, statusMessage: "请先连接平台账号" });
    if (!session.location)
      throw createError({ statusCode: 400, statusMessage: "请先设置收餐地址" });
    if (targets.includes("waimai") && !session.location.cityName)
      throw createError({ statusCode: 400, statusMessage: "请填写收餐地址的城市名称" });
    session.lastSync = Date.now();
    await saveSession(id, session);
    syncingSessions.add(id);
    return { snapshot: structuredClone(session), targets };
  });
  try {
    const scope = { radiusMeters: COMPARISON_RADIUS_METERS };
    const results = await Promise.all(targets.map(async provider => {
      try {
        const offers: Offer[] = provider === "xiaochan"
          ? await fetchXiaochan(snapshot.xiaochanAccount!, snapshot.location!, scope)
          : provider === "waimai"
            ? await fetchWaimai(snapshot.waimaiAccount!, snapshot.location!, fetch, scope)
            : await fetchMeituan(id, snapshot.location!, scope);
        const enrollments = provider === "xiaochan" ? await fetchXiaochanEnrollmentUpdates(snapshot, offers) : undefined;
        return { provider, offers, enrollments, updatedAt: new Date().toISOString() };
      } catch (error: any) {
        return { provider, error };
      }
    }));
    return await withSessionLock(id, async () => {
      const session = await loadSession(id);
      const errors: string[] = [];
      const sameLocation = JSON.stringify(session.location) === JSON.stringify(snapshot.location);
      for (const result of results) {
        const { provider } = result;
        if (!sameLocation || !samePlatformAccount(session, snapshot, provider) ||
          !["connected", "configured"].includes(session.connections[provider].state)) continue;
        if (result.error) {
          const message = result.error.statusMessage || result.error.message || "平台同步失败";
          errors.push(message);
          if (result.error.statusCode === 401) session.connections[provider] = {
            ...session.connections[provider], state: "expired", label: "登录已失效", message,
          };
          continue;
        }
        session.offers[provider] = result.offers!;
        if (result.enrollments) {
          applyXiaochanEnrollmentUpdates(session, snapshot, result.enrollments.updates);
          errors.push(...result.enrollments.errors);
        }
        session.updatedAt[provider] = result.updatedAt;
        session.connections[provider] = {
          ...session.connections[provider], state: "connected",
          label: provider === "meituan" ? session.connections.meituan.label : "已登录",
          updatedAt: result.updatedAt,
          ...(provider === "meituan" && session.connections.meituan.state === "configured" ? { message: "连接成功" } : {}),
        };
      }
      await saveSession(id, session);
      return { data: publicSession(session), errors,
        message: errors.length ? "部分平台同步失败" : "同步完成",
      };
    });
  } finally {
    syncingSessions.delete(id);
  }
});
