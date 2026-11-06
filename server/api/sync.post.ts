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

const syncingSessions = new Map<string, Set<Provider>>();

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body?.provider !== undefined && !["xiaochan", "waimai"].includes(body.provider))
    throw createError({ statusCode: 400, statusMessage: "请选择霸王餐平台" });
  const { snapshot, targets } = await withSessionLock(id, async () => {
    const session = await loadSession(id);
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
    const now = Date.now();
    const readyTargets = targets.filter(provider => !syncingSessions.get(id)?.has(provider) &&
      now - (session.lastSyncByProvider?.[provider] ?? 0) >= 30_000);
    if (!readyTargets.length)
      throw createError({ statusCode: 429, statusMessage: "请等待 30 秒后重试" });
    session.lastSync = now;
    session.lastSyncByProvider ||= {};
    for (const provider of readyTargets) session.lastSyncByProvider[provider] = now;
    await saveSession(id, session);
    const active = syncingSessions.get(id) || new Set<Provider>();
    for (const provider of readyTargets) active.add(provider);
    syncingSessions.set(id, active);
    return { snapshot: structuredClone(session), targets: readyTargets };
  });
  try {
    const scope = { radiusMeters: COMPARISON_RADIUS_METERS };
    const results = await Promise.all(targets.map(async provider => {
      const result = await (async () => {
        try {
          const offers: Offer[] = provider === "xiaochan"
            ? await fetchXiaochan(snapshot.xiaochanAccount!, snapshot.location!, scope)
            : provider === "waimai"
              ? await fetchWaimai(snapshot.waimaiAccount!, snapshot.location!, fetch, scope)
              : await fetchMeituan(id, snapshot.location!, scope);
          const enrollments = provider === "xiaochan" ? await fetchXiaochanEnrollmentUpdates(snapshot, offers) : undefined;
          return { offers, enrollments, updatedAt: new Date().toISOString() };
        } catch (error: any) {
          return { error };
        }
      })();
      return withSessionLock(id, async () => {
        const session = await loadSession(id);
        const errors: string[] = [];
        const sameLocation = JSON.stringify(session.location) === JSON.stringify(snapshot.location);
        if (!sameLocation || !samePlatformAccount(session, snapshot, provider) ||
          !["connected", "configured"].includes(session.connections[provider].state)) return errors;
        if (result.error) {
          const message = result.error.statusMessage || result.error.message || "平台同步失败";
          errors.push(message);
          if (result.error.statusCode === 401) session.connections[provider] = {
            ...session.connections[provider], state: "expired", label: "登录已失效", message,
          };
        } else {
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
        return errors;
      });
    }));
    return await withSessionLock(id, async () => {
      const session = await loadSession(id);
      const errors = results.flat();
      return { data: publicSession(session), errors,
        message: errors.length ? "部分平台同步失败" : "同步完成",
      };
    });
  } finally {
    const active = syncingSessions.get(id);
    for (const provider of targets) active?.delete(provider);
    if (!active?.size) syncingSessions.delete(id);
  }
});
