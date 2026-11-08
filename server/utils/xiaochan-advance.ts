import { createError } from "h3";
import type { EnrollmentTimeWindow, Offer, XiaochanScheduleOptions } from "../../shared/types";
import { xiaochanAdvanceWindow } from "../../shared/utils/xiaochan-advance-time";
import { COMPARISON_RADIUS_METERS, offerWithinRadius } from "../../shared/utils/scope";
import type { LocalSession } from "./session";
import { xiaochanAccountHeaders, xiaochanRpc } from "./xiaochan-rpc";
import { fetchXiaochanAdvanceCoupons } from "./xiaochan-advance-coupons";
import { assertAdvanceCouponCapacity, withXiaochanAdvanceLock, xiaochanAdvanceReservations } from "./xiaochan-advance-lock";

export const xiaochanAdvanceAccountId = (session: LocalSession) =>
  `${session.xiaochanAccount?.silkId}:${session.xiaochanAccount?.userId}`;

export function xiaochanScheduleOffer(session: LocalSession, input: unknown, snapshot?: Offer): Offer {
  if (!session.xiaochanAccount || session.connections.xiaochan.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录小蚕" });
  xiaochanAccountHeaders(session.xiaochanAccount);
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input) ||
    !Number.isSafeInteger(Number(input.slice(9))))
    throw createError({ statusCode: 400, statusMessage: "请选择小蚕活动" });
  const offer = snapshot?.id === input ? snapshot : session.offers.xiaochan.find(row => row.id === input);
  if (!offer || offer.source !== "live" || offer.provider !== "xiaochan")
    throw createError({ statusCode: 404, statusMessage: "活动已更新，请重新同步" });
  if (!session.location)
    throw createError({ statusCode: 400, statusMessage: "请先设置收餐地址" });
  if (!offerWithinRadius(offer, COMPARISON_RADIUS_METERS))
    throw createError({ statusCode: 409, statusMessage: "活动暂不可预约" });
  return offer;
}

function time(hour: unknown, minute: unknown): string | undefined {
  if (typeof hour === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(hour)) return hour;
  if (!["number", "string"].includes(typeof hour) || !/^\d{1,2}$/.test(String(hour))) return;
  const h = Number(hour), m = minute == null ? 0 : Number(minute);
  if (!Number.isInteger(m) || m < 0 || m > 59 || h > 24 || (h === 24 && m !== 0)) return;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Call while holding the account lock when the result will authorize a new reservation or request.
export async function loadXiaochanAdvanceContext(
  session: LocalSession,
  input: unknown,
  { rpc = xiaochanRpc, now = new Date(), offer: snapshot }: { rpc?: typeof xiaochanRpc; now?: Date; offer?: Offer } = {},
) {
  const offer = xiaochanScheduleOffer(session, input, snapshot);
  if (!xiaochanAdvanceWindow(offer, new Date(now.getTime() - 1)))
    throw createError({ statusCode: 409, statusMessage: "当前不在超前抢单时段" });
  const detail = await rpc({
    headers: xiaochanAccountHeaders(session.xiaochanAccount!),
    serverName: "Silkworm", methodName: "SilkwormService.GetStorePromotionDetail", location: session.location,
    body: { silk_id: Number(session.xiaochanAccount!.silkId), promotion_id: Number(offer.id.slice(9)) },
  });
  const promotion = detail?.promotion_detail;
  if (!detail?.status || ![0, "0"].includes(detail.status.code) ||
    String(promotion?.promotion_id) !== offer.id.slice(9) || ![1, "1"].includes(promotion?.meituan_status))
    throw createError({ statusCode: 502, statusMessage: "小蚕活动状态无法确认，请重试" });
  if (promotion.if_seckill || promotion.is_major || promotion.is_brand_promotion || promotion.is_brand ||
    Number(promotion.big_brand_type) === 4 || offer.advanceEnrollmentAvailable === false)
    throw createError({ statusCode: 409, statusMessage: "活动不支持超前抢单" });
  const startTime = time(promotion.start_time_hour, promotion.start_time_minute);
  if (!startTime)
    throw createError({ statusCode: 502, statusMessage: "小蚕活动时间无法确认，请重试" });
  // Keep the original activity's date, end and inventory constraints. Never change pricing availability.
  const verifiedOffer = { ...offer, startTime };
  const window = xiaochanAdvanceWindow(verifiedOffer, new Date(now.getTime() - 1));
  if (!window) throw createError({ statusCode: 409, statusMessage: "当前不在超前抢单时段" });
  const coupons = await fetchXiaochanAdvanceCoupons(session.xiaochanAccount!, session.location, { rpc, now });
  const reservations = await xiaochanAdvanceReservations(xiaochanAdvanceAccountId(session), session, offer.id);
  // Due tasks can be a few milliseconds late while waiting for this account's lock.
  const pending = reservations.map(reservation => ({ ...reservation,
    runAt: new Date(Math.max(Date.parse(reservation.runAt), now.getTime())).toISOString(),
  }));
  return { offer: verifiedOffer, window, coupons, reservations: pending };
}

export function advanceContextWindows(context: Awaited<ReturnType<typeof loadXiaochanAdvanceContext>>, now: Date): EnrollmentTimeWindow[] {
  const { window, coupons, reservations } = context;
  const start = Math.max(window.start, now.getTime() + 1), end = window.end;
  if (start >= end) return [];
  const points = [...new Set([start, end, ...coupons.flatMap(coupon => [coupon.startsAt, coupon.expiresAt]),
    ...reservations.map(reservation => Date.parse(reservation.runAt))]
    .filter(value => value >= start && value <= end))].sort((a, b) => a - b);
  const windows: EnrollmentTimeWindow[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!, to = points[i + 1]!;
    try {
      assertAdvanceCouponCapacity(coupons, [...reservations, { offerId: context.offer.id, runAt: new Date(from).toISOString() }]);
      const previous = windows.at(-1);
      if (previous?.end === from) previous.end = to;
      else windows.push({ start: from, end: to });
    } catch (error: any) {
      if (error.statusCode !== 409) throw error;
    }
  }
  return windows;
}

export async function getXiaochanScheduleOptions(session: LocalSession, input: unknown, {
  rpc = xiaochanRpc, now: fixedNow,
}: { rpc?: typeof xiaochanRpc; now?: Date } = {}): Promise<XiaochanScheduleOptions> {
  const now = fixedNow ?? new Date();
  const offer = xiaochanScheduleOffer(session, input);
  if (!xiaochanAdvanceWindow(offer, now)) return { offerId: offer.id, advanceWindows: [] };
  return withXiaochanAdvanceLock(xiaochanAdvanceAccountId(session), async () => {
    const context = await loadXiaochanAdvanceContext(session, input, { rpc, now: fixedNow ?? new Date() });
    return { offerId: offer.id, advanceWindows: advanceContextWindows(context, fixedNow ?? new Date()) };
  });
}
