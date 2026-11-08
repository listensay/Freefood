import { createError } from "h3";
import { canScheduleEnrollment } from "../../shared/utils/enrollment-time";
import { COMPARISON_RADIUS_METERS, offerWithinRadius } from "../../shared/utils/scope";
import { enrollWaimai } from "./waimai-enrollment";
import { assertWaimaiAccount } from "./waimai";
import { loadSession, saveSession, storedSessionIds, withSessionLock, type LocalSession } from "./session";

const timers = new Map<string, { runAt: string; timer: ReturnType<typeof setTimeout> }>();
const accountId = (session: LocalSession) => `${session.waimaiAccount?.uid}:${session.waimaiAccount?.userId}`;

export function setWaimaiSchedule(session: LocalSession, input: unknown, time: unknown, now = new Date()) {
  if (!session.waimaiAccount || session.connections.waimai.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录歪麦" });
  assertWaimaiAccount(session.waimaiAccount);
  if (typeof input !== "string" || !/^waimai:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/.test(input))
    throw createError({ statusCode: 400, statusMessage: "请选择歪麦活动" });
  if (typeof time !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|\+08:00)$/.test(time))
    throw createError({ statusCode: 400, statusMessage: "请选择有效的报名时间" });
  const offer = session.offers.waimai.find(row => row.id === input);
  if (!offer || offer.source !== "live" || offer.provider !== "waimai")
    throw createError({ statusCode: 404, statusMessage: "活动已更新，请重新同步" });
  if (offer.enrollmentAvailable !== true)
    throw createError({ statusCode: 409, statusMessage: "活动暂不可预约" });
  if (!session.location || !session.location.cityName?.trim())
    throw createError({ statusCode: 400, statusMessage: "请先设置收餐地址和城市名称" });
  if (session.waimaiEnrollments?.[input] || session.waimaiSchedules?.[input]?.state === "running")
    throw createError({ statusCode: 409, statusMessage: "活动已有报名，请先确认状态" });
  const runAt = new Date(time);
  if (!canScheduleEnrollment(offer, runAt, now) || !offerWithinRadius(offer, COMPARISON_RADIUS_METERS))
    throw createError({ statusCode: 400, statusMessage: "请选择今天的活动有效时间" });
  const { enrollment: _enrollment, enrollmentSchedule: _schedule, ...activity } = offer;
  const schedule = {
    offerId: input, name: offer.name, runAt: runAt.toISOString(), state: "scheduled" as const,
    offer: structuredClone(activity), location: structuredClone(session.location), accountId: accountId(session),
  };
  (session.waimaiSchedules ||= {})[input] = schedule;
  return schedule;
}

export function cancelWaimaiSchedule(session: LocalSession, input: unknown) {
  if (typeof input !== "string" || !/^waimai:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/.test(input))
    throw createError({ statusCode: 400, statusMessage: "请选择歪麦活动" });
  if (session.waimaiSchedules?.[input]?.state === "running")
    throw createError({ statusCode: 409, statusMessage: "报名正在执行" });
  if (!session.waimaiSchedules?.[input] && session.waimaiEnrollments?.[input])
    throw createError({ statusCode: 409, statusMessage: "报名已执行，请查看报名状态" });
  delete session.waimaiSchedules?.[input];
}

export async function runWaimaiSchedule(
  session: LocalSession,
  offerId: string,
  { persist, transport, now = new Date() }: { persist: () => Promise<void>; transport?: typeof fetch; now?: Date },
) {
  const schedule = session.waimaiSchedules?.[offerId];
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
    if (schedule.offer.enrollmentAvailable !== true || !canScheduleEnrollment(schedule.offer, now, new Date(now.getTime() - 1)))
      throw createError({ statusCode: 409, statusMessage: "活动已结束或不可报名" });
    if (session.waimaiEnrollments?.[offerId]?.state === "enrolled") {
      delete session.waimaiSchedules![offerId];
      await persist();
      return;
    }
    // Preserve the selected activity tier; the upstream request checks availability at execution time.
    const offer = { ...schedule.offer, collectedAt: now.toISOString() };
    const index = session.offers.waimai.findIndex(row => row.id === offerId);
    if (index < 0) session.offers.waimai.push(offer);
    else session.offers.waimai[index] = offer;
    await enrollWaimai(session, offerId, { persist, transport, now });
    delete session.waimaiSchedules![offerId];
  } catch (error: any) {
    schedule.state = "failed";
    schedule.message = error.statusMessage || "预约报名失败";
  }
  await persist();
}

export function armWaimaiSchedules(id: string, session: LocalSession) {
  const prefix = `${id}:`;
  for (const [key, existing] of timers) {
    if (!key.startsWith(prefix)) continue;
    const schedule = session.waimaiSchedules?.[key.slice(prefix.length)];
    if (!schedule || schedule.state !== "scheduled" || schedule.runAt !== existing.runAt) {
      clearTimeout(existing.timer);
      timers.delete(key);
    }
  }
  for (const schedule of Object.values(session.waimaiSchedules || {})) {
    const key = `${prefix}${schedule.offerId}`;
    if (schedule.state !== "scheduled" || timers.has(key)) continue;
    const runAt = schedule.runAt;
    const timer = setTimeout(() => {
      if (timers.get(key)?.timer === timer) timers.delete(key);
      void withSessionLock(id, async () => {
        const current = await loadSession(id);
        if (current.waimaiSchedules?.[schedule.offerId]?.runAt !== runAt) return;
        if (Date.parse(runAt) > Date.now()) {
          armWaimaiSchedules(id, current);
          return;
        }
        try {
          await runWaimaiSchedule(current, schedule.offerId, { persist: () => saveSession(id, current) });
        } catch {
          const failed = current.waimaiSchedules?.[schedule.offerId];
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

export async function restoreWaimaiSchedules() {
  for (const id of await storedSessionIds()) {
    await withSessionLock(id, async () => {
      const session = await loadSession(id);
      let changed = false;
      for (const schedule of Object.values(session.waimaiSchedules || {})) {
        if (schedule.state !== "running") continue;
        if (session.waimaiEnrollments?.[schedule.offerId]?.state === "enrolled")
          delete session.waimaiSchedules![schedule.offerId];
        else {
          schedule.state = "failed";
          schedule.message = session.waimaiEnrollments?.[schedule.offerId] ? "报名待确认" : "预约报名已中断";
        }
        changed = true;
      }
      if (changed) await saveSession(id, session);
      armWaimaiSchedules(id, session);
    }).catch(() => {});
  }
}

export function closeWaimaiSchedules() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear();
}
