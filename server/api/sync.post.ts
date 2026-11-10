import { defineEventHandler, readBody, createError, setResponseHeader } from "h3";
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
import { nextAutomaticSyncTime } from "../../shared/utils/sync-time";
import { applyXiaochanEnrollmentUpdates, fetchXiaochanEnrollmentUpdates } from "../utils/xiaochan-enrollment";
import { applyWaimaiEnrollmentUpdates, fetchWaimaiEnrollmentUpdates } from "../utils/waimai-enrollment";
import { logFailureReason, logOperation } from "../utils/runtime-logs";

const syncingSessions = new Map<string, Set<Provider>>();
const XIAOCHAN_WAF_BACKOFF_MS = [15, 30, 60].map(minutes => minutes * 60_000);
const XIAOCHAN_BLOCK_MESSAGE = "小蚕请求被拦截，请稍后重试";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (body?.provider !== undefined && !["xiaochan", "waimai"].includes(body.provider))
    throw createError({ statusCode: 400, statusMessage: "请选择霸王餐平台" });
  const { snapshot, targets, skippedErrors } = await withSessionLock(id, async () => {
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
    const waitMs = (provider: Provider) => {
      const lastSync = session.lastSyncByProvider?.[provider];
      const nextSync = lastSync === undefined ? now : body?.automatic === true
        ? nextAutomaticSyncTime(lastSync, provider) : lastSync + 30_000;
      return Math.max(0, nextSync - now,
        provider === "xiaochan" ? (session.xiaochanSyncBackoff?.retryAt ?? 0) - now : 0);
    };
    const readyTargets = targets.filter(provider => !syncingSessions.get(id)?.has(provider) &&
      waitMs(provider) === 0);
    // Keep the previous WAF error visible until Xiaochan itself has recovered.
    const skippedErrors = targets.includes("xiaochan") && !readyTargets.includes("xiaochan") && session.xiaochanSyncBackoff
      ? [XIAOCHAN_BLOCK_MESSAGE] : [];
    if (!readyTargets.length) {
      const retryMs = Math.min(...targets.map(provider =>
        Math.max(waitMs(provider), syncingSessions.get(id)?.has(provider) ? 30_000 : 0)));
      setResponseHeader(event, "Retry-After", Math.max(1, Math.ceil(retryMs / 1000)));
      throw createError({ statusCode: 429, statusMessage: skippedErrors[0] ||
        (body?.automatic === true ? "请稍后再同步" : "请等待 30 秒后重试") });
    }
    session.lastSync = now;
    session.lastSyncByProvider ||= {};
    for (const provider of readyTargets) session.lastSyncByProvider[provider] = now;
    await saveSession(id, session);
    const active = syncingSessions.get(id) || new Set<Provider>();
    for (const provider of readyTargets) active.add(provider);
    syncingSessions.set(id, active);
    return { snapshot: structuredClone(session), targets: readyTargets, skippedErrors };
  });
  try {
    const scope = { radiusMeters: COMPARISON_RADIUS_METERS };
    const results = await Promise.all(targets.map(async provider => {
      const result = await (async () => {
        try {
          return await logOperation({ provider }, async () => {
            const offers: Offer[] = provider === "xiaochan"
              ? await fetchXiaochan(snapshot.xiaochanAccount!, snapshot.location!, scope)
              : provider === "waimai"
                ? await fetchWaimai(snapshot.waimaiAccount!, snapshot.location!, fetch, scope)
                : await fetchMeituan(id, snapshot.location!, scope);
            const enrollments = provider === "xiaochan" ? await fetchXiaochanEnrollmentUpdates(snapshot, offers)
              : provider === "waimai" ? await fetchWaimaiEnrollmentUpdates(snapshot, offers) : undefined;
            return { offers, enrollments, errors: enrollments?.errors, updatedAt: new Date().toISOString() };
          });
        } catch (error: any) {
          return { error };
        }
      })();
      return withSessionLock(id, async () => {
        const session = await loadSession(id);
        const errors: string[] = [];
        const sameLocation = JSON.stringify(session.location) === JSON.stringify(snapshot.location);
        if (!samePlatformAccount(session, snapshot, provider) ||
          !["connected", "configured"].includes(session.connections[provider].state)) return errors;
        if (provider === "xiaochan") {
          const blocked = "error" in result
            ? logFailureReason(result.error) === "gateway-blocked"
            : result.errors?.some(message => logFailureReason({ message }) === "gateway-blocked");
          if (blocked) {
            const consecutiveBlocks = Math.min((session.xiaochanSyncBackoff?.consecutiveBlocks ?? 0) + 1,
              XIAOCHAN_WAF_BACKOFF_MS.length);
            session.xiaochanSyncBackoff = { consecutiveBlocks,
              retryAt: Date.now() + XIAOCHAN_WAF_BACKOFF_MS[consecutiveBlocks - 1]! };
          } else if (!("error" in result) && !result.errors?.length && sameLocation) {
            delete session.xiaochanSyncBackoff;
          }
        }
        // A location change discards old activities, but must not discard a WAF cooldown.
        if (!sameLocation) {
          await saveSession(id, session);
          return errors;
        }
        if ("error" in result) {
          const message = result.error.statusMessage || result.error.message || "平台同步失败";
          errors.push(message);
          if (result.error.statusCode === 401) session.connections[provider] = {
            ...session.connections[provider], state: "expired", label: "登录已失效", message,
          };
        } else {
          session.offers[provider] = result.offers!;
          if (result.enrollments) {
            if (provider === "waimai") applyWaimaiEnrollmentUpdates(session, snapshot, result.enrollments.updates);
            else applyXiaochanEnrollmentUpdates(session, snapshot, result.enrollments.updates);
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
      const errors = [...skippedErrors, ...results.flat()];
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
