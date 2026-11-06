import { createError } from "h3";
import { canScheduleEnrollment } from "../../shared/utils/enrollment-time";
import { COMPARISON_RADIUS_METERS, offerWithinRadius } from "../../shared/utils/scope";
import { enrollXiaochan } from "./xiaochan-enrollment";
import { xiaochanAccountHeaders, type xiaochanRpc } from "./xiaochan-rpc";
import { loadSession, saveSession, storedSessionIds, withSessionLock, type LocalSession } from "./session";

const timers = new Map<string, { runAt: string; timer: ReturnType<typeof setTimeout> }>();
const accountId = (session: LocalSession) => `${session.xiaochanAccount?.silkId}:${session.xiaochanAccount?.userId}`;

export function setXiaochanSchedule(session: LocalSession, input: unknown, time: unknown, now = new Date()) {
  if (!session.xiaochanAccount || session.connections.xiaochan.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录小蚕" });
  xiaochanAccountHeaders(session.xiaochanAccount);
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input))
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
  if (!canScheduleEnrollment(offer, runAt, now) || !offerWithinRadius(offer, COMPARISON_RADIUS_METERS))
    throw createError({ statusCode: 400, statusMessage: "请选择今天的活动有效时间" });
  const { enrollment: _enrollment, enrollmentSchedule: _schedule, ...activity } = offer;
  const schedule = {
    offerId: input, name: offer.name, runAt: runAt.toISOString(), state: "scheduled" as const,
    offer: structuredClone(activity), location: structuredClone(session.location), accountId: accountId(session),
  };
  (session.xiaochanSchedules ||= {})[input] = schedule;
  return schedule;
}

export function cancelXiaochanSchedule(session: LocalSession, input: unknown) {
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input))
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
  { persist, rpc, now = new Date() }: { persist: () => Promise<void>; rpc?: typeof xiaochanRpc; now?: Date },
) {
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
    if (!canScheduleEnrollment(schedule.offer, now, new Date(now.getTime() - 1)))
      throw createError({ statusCode: 409, statusMessage: "活动已结束或不可报名" });
    if (session.xiaochanEnrollments?.[offerId]?.state === "enrolled") {
      delete session.xiaochanSchedules![offerId];
      await persist();
      return;
    }
    // The saved activity fixes the user's chosen tier; the quota RPC checks availability at execution time.
    const offer = { ...schedule.offer, collectedAt: now.toISOString() };
    const index = session.offers.xiaochan.findIndex(row => row.id === offerId);
    if (index < 0) session.offers.xiaochan.push(offer);
    else session.offers.xiaochan[index] = offer;
    await enrollXiaochan(session, offerId, { persist, rpc, now });
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
          await runXiaochanSchedule(current, schedule.offerId, { persist: () => saveSession(id, current) });
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
      let changed = false;
      for (const schedule of Object.values(session.xiaochanSchedules || {})) {
        if (schedule.state !== "running") continue;
        if (session.xiaochanEnrollments?.[schedule.offerId]?.state === "enrolled")
          delete session.xiaochanSchedules![schedule.offerId];
        else {
          schedule.state = "failed";
          schedule.message = session.xiaochanEnrollments?.[schedule.offerId] ? "报名待确认" : "预约报名已中断";
        }
        changed = true;
      }
      if (changed) await saveSession(id, session);
      armXiaochanSchedules(id, session);
    }).catch(() => {});
  }
}

export function closeXiaochanSchedules() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear();
}
