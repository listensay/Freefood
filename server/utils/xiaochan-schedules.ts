import { logEvent, logOperation, withLogContext } from "./runtime-logs";
import { randomUUID } from "node:crypto";
import { createError } from "h3";
import type { Offer } from "../../shared/types";
import { xiaochanAdvanceWindow } from "../../shared/utils/xiaochan-advance-time";
import { loadXiaochanAdvanceContext, xiaochanAdvanceAccountId } from "./xiaochan-advance";
import { assertAdvanceCouponCapacity, withXiaochanAdvanceLock } from "./xiaochan-advance-lock";
import { canScheduleEnrollment } from "../../shared/utils/enrollment-time";
import { COMPARISON_RADIUS_METERS, offerWithinRadius } from "../../shared/utils/scope";
import { enrollXiaochan } from "./xiaochan-enrollment";
import { xiaochanAccountHeaders, type xiaochanRpc } from "./xiaochan-rpc";
import { loadSession, saveSession, storedSessionIds, withSessionLock, type LocalSession } from "./session";

const timers = new Map<string, { runAt: string; timer: ReturnType<typeof setTimeout> }>();
const accountId = (session: LocalSession) => `${session.xiaochanAccount?.silkId}:${session.xiaochanAccount?.userId}`;

function scheduleInput(session: LocalSession, input: unknown, time: unknown) {
  if (!session.xiaochanAccount || session.connections.xiaochan.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录小蚕" });
  xiaochanAccountHeaders(session.xiaochanAccount);
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input.slice(9))))
    throw createError({ statusCode: 400, statusMessage: "请选择小蚕活动" });
  if (typeof time !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|\+08:00)$/.test(time))
    throw createError({ statusCode: 400, statusMessage: "请选择有效的报名时间" });
  const offer = session.offers.xiaochan.find(row => row.id === input);
  if (!offer || offer.source !== "live" || offer.provider !== "xiaochan")
    throw createError({ statusCode: 404, statusMessage: "活动已更新，请重新同步" });
  if (!session.location)
    throw createError({ statusCode: 400, statusMessage: "请先设置收餐地址" });
  if (session.xiaochanEnrollments?.[input] || session.xiaochanSchedules?.[input]?.state === "running")
    throw createError({ statusCode: 409, statusMessage: "活动已有报名，请先确认状态" });
  const runAt = new Date(time);
  if (!Number.isFinite(runAt.getTime()) || !offerWithinRadius(offer, COMPARISON_RADIUS_METERS))
    throw createError({ statusCode: 400, statusMessage: "请选择今天的活动有效时间" });
  return { offer, runAt };
}

function storeSchedule(session: LocalSession, offer: Offer, runAt: Date, advanceOrder = false) {
  const { enrollment: _enrollment, enrollmentSchedule: _schedule, ...activity } = offer;
  const schedule = {
    offerId: offer.id, name: offer.name, runAt: runAt.toISOString(), state: "scheduled" as const,
    offer: structuredClone(activity), location: structuredClone(session.location!), accountId: accountId(session),
    ...(advanceOrder ? { advanceOrder: true } : {}),
  };
  (session.xiaochanSchedules ||= {})[offer.id] = schedule;
  return schedule;
}

export function setXiaochanSchedule(session: LocalSession, input: unknown, time: unknown, now = new Date()) {
  const { offer, runAt } = scheduleInput(session, input, time);
  if (!canScheduleEnrollment(offer, runAt, now))
    throw createError({ statusCode: 400, statusMessage: "请选择今天的活动有效时间" });
  return storeSchedule(session, offer, runAt);
}

export async function createXiaochanSchedule(
  session: LocalSession, input: unknown, time: unknown,
  { persist, rpc, now }: { persist: () => Promise<void>; rpc?: typeof xiaochanRpc; now?: Date },
) {
  const { offer, runAt } = scheduleInput(session, input, time);
  const save = async (verifiedOffer: Offer, advanceOrder = false) => {
    const previous = session.xiaochanSchedules?.[offer.id];
    const schedule = storeSchedule(session, verifiedOffer, runAt, advanceOrder);
    try { await persist(); } catch (error) {
      if (previous) session.xiaochanSchedules![offer.id] = previous;
      else delete session.xiaochanSchedules?.[offer.id];
      throw error;
    }
    return schedule;
  };
  return withXiaochanAdvanceLock(xiaochanAdvanceAccountId(session), async () => {
    const current = now ?? new Date();
    if (canScheduleEnrollment(offer, runAt, current)) return save(offer);
    const potential = xiaochanAdvanceWindow(offer, current);
    if (!potential || runAt.getTime() < potential.start || runAt.getTime() >= potential.end)
      throw createError({ statusCode: 400, statusMessage: "请选择今天的活动有效时间" });
    const context = await loadXiaochanAdvanceContext(session, input, { rpc, now: now ?? new Date() });
    const checkedAt = now ?? new Date();
    const window = xiaochanAdvanceWindow(context.offer, checkedAt);
    if (!window || runAt.getTime() < window.start || runAt.getTime() >= window.end)
      throw createError({ statusCode: 400, statusMessage: "请选择今天的活动有效时间" });
    assertAdvanceCouponCapacity(context.coupons, [...context.reservations, { offerId: offer.id, runAt: runAt.toISOString() }]);
    return save(context.offer, true);
  });
}

export function cancelXiaochanSchedule(session: LocalSession, input: unknown) {
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input.slice(9))))
    throw createError({ statusCode: 400, statusMessage: "请选择小蚕活动" });
  if (session.xiaochanSchedules?.[input]?.state === "running")
    throw createError({ statusCode: 409, statusMessage: "报名正在执行" });
  if (!session.xiaochanSchedules?.[input] && session.xiaochanEnrollments?.[input])
    throw createError({ statusCode: 409, statusMessage: "报名已执行，请查看报名状态" });
  delete session.xiaochanSchedules?.[input];
}

export async function runXiaochanSchedule(
  session: LocalSession,
  offerId: string,
  { persist, rpc, now: fixedNow }: { persist: () => Promise<void>; rpc?: typeof xiaochanRpc; now?: Date },
) {
  const now = fixedNow ?? new Date();
  const schedule = session.xiaochanSchedules?.[offerId];
  if (!schedule || schedule.state !== "scheduled" || Date.parse(schedule.runAt) > now.getTime()) return;
  schedule.state = "running";
  try { await persist(); } catch (error) {
    schedule.state = "scheduled";
    throw error;
  }
  try {
    if (now.getTime() - Date.parse(schedule.runAt) > 60_000)
      throw createError({ statusCode: 409, statusMessage: "预约报名已过期" });
    if (accountId(session) !== schedule.accountId || JSON.stringify(session.location) !== JSON.stringify(schedule.location))
      throw createError({ statusCode: 409, statusMessage: "账号或地址已更新" });
    if (session.xiaochanEnrollments?.[offerId]?.state === "enrolled") {
      delete session.xiaochanSchedules![offerId];
      await persist();
      return;
    }
    // Use the selected activity snapshot without changing pricing or activity availability.
    const execute = async (offer: Offer, at: Date, advanceOrder = false, beforeSubmit?: () => boolean) => {
      if (at.getTime() - Date.parse(schedule.runAt) > 60_000)
        throw createError({ statusCode: 409, statusMessage: "预约报名已过期" });
      if (!session.offers.xiaochan.some(row => row.id === offerId))
        session.offers.xiaochan.push({ ...schedule.offer, collectedAt: at.toISOString() });
      await enrollXiaochan(session, offerId, {
        persist, rpc, now: at, advanceOrder, beforeSubmit,
        offerSnapshot: { ...offer, collectedAt: at.toISOString() },
      });
      delete session.xiaochanSchedules![offerId];
      await persist();
    };
    const ordinary = (offer: Offer, at: Date) => canScheduleEnrollment(offer, at, new Date(at.getTime() - 1));
    if (ordinary(schedule.offer, now)) await execute(schedule.offer, now);
    else if (schedule.advanceOrder === true) {
      await withXiaochanAdvanceLock(schedule.accountId, async () => {
        const at = fixedNow ?? new Date();
        if (ordinary(schedule.offer, at)) return execute(schedule.offer, at);
        // Preserve session identity for cross-session capacity checks; only override the activity snapshot.
        const context = await loadXiaochanAdvanceContext(session, offerId, { rpc, now: at, offer: schedule.offer });
        const checkedAt = fixedNow ?? new Date();
        if (ordinary(context.offer, checkedAt)) return execute(context.offer, checkedAt);
        const beforeSubmit = () => {
          const at = fixedNow ?? new Date();
          if (at.getTime() - Date.parse(schedule.runAt) > 60_000)
            throw createError({ statusCode: 409, statusMessage: "预约报名已过期" });
          if (ordinary(context.offer, at)) return false;
          const window = xiaochanAdvanceWindow(context.offer, new Date(at.getTime() - 1));
          if (!window || at.getTime() < window.start || at.getTime() >= window.end)
            throw createError({ statusCode: 409, statusMessage: "当前不在超前抢单时段" });
          assertAdvanceCouponCapacity(context.coupons, [...context.reservations,
            { offerId, runAt: at.toISOString() },
          ]);
          return true;
        };
        beforeSubmit();
        await execute(context.offer, checkedAt, true, beforeSubmit);
      });
    } else throw createError({ statusCode: 409, statusMessage: "活动已结束或不可报名" });
    delete session.xiaochanSchedules![offerId];
  } catch (error: any) {
    schedule.state = "failed";
    schedule.message = error.statusMessage || "预约报名失败";
  }
  await persist();
}

export function armXiaochanSchedules(id: string, session: LocalSession) {
  const prefix = `${id}:`;
  for (const [key, existing] of timers) {
    if (!key.startsWith(prefix)) continue;
    const schedule = session.xiaochanSchedules?.[key.slice(prefix.length)];
    if (!schedule || schedule.state !== "scheduled" || schedule.runAt !== existing.runAt) {
      clearTimeout(existing.timer);
      timers.delete(key);
    }
  }
  for (const schedule of Object.values(session.xiaochanSchedules || {})) {
    const key = `${prefix}${schedule.offerId}`;
    if (schedule.state !== "scheduled" || timers.has(key)) continue;
    const runAt = schedule.runAt;
    const timer = setTimeout(() => {
      if (timers.get(key)?.timer === timer) timers.delete(key);
      void withSessionLock(id, async () => {
        const current = await loadSession(id);
        if (current.xiaochanSchedules?.[schedule.offerId]?.runAt !== runAt) return;
        if (Date.parse(runAt) > Date.now()) {
          armXiaochanSchedules(id, current);
          return;
        }
        try {
          await logOperation({ sessionId: id, traceId: randomUUID(), action: "enroll", provider: "xiaochan", source: "schedule", scheduledAt: runAt }, async () => {
            await runXiaochanSchedule(current, schedule.offerId, { persist: () => saveSession(id, current) });
            const failed = current.xiaochanSchedules?.[schedule.offerId];
            return { errors: failed?.state === "failed" ? [failed.message || "预约报名失败"] : [] };
          });
        } catch {
          const failed = current.xiaochanSchedules?.[schedule.offerId];
          if (failed) {
            failed.state = "failed";
            failed.message = "预约报名失败";
            await saveSession(id, current);
          }
        }
      }).catch(() => {});
    }, Math.max(0, Date.parse(runAt) - Date.now()));
    timer.unref();
    timers.set(key, { runAt, timer });
  }
}

export async function restoreXiaochanSchedules() {
  for (const id of await storedSessionIds()) {
    await withSessionLock(id, async () => {
      const session = await loadSession(id);
      let changed = false, interrupted = false;
      const restored = Object.values(session.xiaochanSchedules || {}).some(schedule => schedule.state === "scheduled");
      for (const schedule of Object.values(session.xiaochanSchedules || {})) {
        if (schedule.state !== "running") continue;
        if (session.xiaochanEnrollments?.[schedule.offerId]?.state === "enrolled")
          delete session.xiaochanSchedules![schedule.offerId];
        else {
          interrupted = true;
          schedule.state = "failed";
          schedule.message = session.xiaochanEnrollments?.[schedule.offerId] ? "报名待确认" : "预约报名已中断";
        }
        changed = true;
      }
      if (changed) await saveSession(id, session);
      if (interrupted || restored) {
        withLogContext({ sessionId: id, traceId: randomUUID(), action: "schedule", source: "system", provider: "xiaochan" }, () =>
          logEvent({ event: "schedule.restored", outcome: interrupted ? "failure" : "success", ...(interrupted ? { reason: "interrupted" } : {}) }));
      }
      armXiaochanSchedules(id, session);
    }).catch(() => {});
  }
}

export function closeXiaochanSchedules() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear();
}
