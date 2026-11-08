import { createError } from "h3";
import { loadSession, storedSessionIds, type LocalSession } from "./session";

const locks = new Map<string, Promise<unknown>>();

export function withXiaochanAdvanceLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(accountId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(accountId, current);
  void current.finally(() => {
    if (locks.get(accountId) === current) locks.delete(accountId);
  }).catch(() => {});
  return current;
}

export async function xiaochanAdvanceReservations(
  accountId: string,
  current: LocalSession,
  excludeOfferId?: string,
): Promise<Array<{ offerId: string; runAt: string }>> {
  const sessions = new Set<LocalSession>([current]);
  // The caller owns the account lock; taking another session lock here could deadlock.
  for (const id of await storedSessionIds()) sessions.add(await loadSession(id));
  const reservations: Array<{ offerId: string; runAt: string }> = [];
  for (const session of sessions) {
    const account = session.xiaochanAccount;
    if (!account || `${account.silkId}:${account.userId}` !== accountId) continue;
    for (const [offerId, enrollment] of Object.entries(session.xiaochanEnrollments || {})) {
      if (session === current && offerId === excludeOfferId) continue;
      if (enrollment.advanceOrder === true && ["unknown", "cancel-unknown"].includes(enrollment.state))
        throw createError({ statusCode: 409, statusMessage: "超前抢单待确认" });
    }
    for (const schedule of Object.values(session.xiaochanSchedules || {})) {
      if (session === current && schedule.offerId === excludeOfferId) continue;
      if (schedule.advanceOrder === true && ["scheduled", "running"].includes(schedule.state))
        reservations.push({ offerId: schedule.offerId, runAt: schedule.runAt });
    }
  }
  return reservations;
}

export function assertAdvanceCouponCapacity(
  coupons: Array<{ id: string; startsAt: number; expiresAt: number }>,
  reservations: Array<{ offerId: string; runAt: string }>,
): void {
  const available = coupons.filter(coupon => typeof coupon.id === "string" && coupon.id.length > 0 &&
    Number.isFinite(coupon.startsAt) && Number.isFinite(coupon.expiresAt) && coupon.startsAt < coupon.expiresAt)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  const times = reservations.map(reservation => Date.parse(reservation.runAt)).sort((a, b) => a - b);
  const used = new Set<string>();
  for (const time of times) {
    const coupon = Number.isFinite(time) && available.find(candidate => !used.has(candidate.id) &&
      candidate.startsAt <= time && time < candidate.expiresAt);
    if (!coupon) throw createError({ statusCode: 409, statusMessage: "超前抢单券不足" });
    used.add(coupon.id);
  }
}
