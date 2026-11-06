import { createError } from "h3";
import { activeAt } from "../../shared/utils/pricing";
import { COMPARISON_RADIUS_METERS, offerWithinRadius } from "../../shared/utils/scope";
import type { LocalSession } from "./session";
import { xiaochanAccountHeaders, xiaochanRpc } from "./xiaochan-rpc";
import type { Offer } from "../../shared/types";

interface EnrollmentOptions {
  persist: () => Promise<void>;
  rpc?: typeof xiaochanRpc;
  now?: Date;
}

const confirmedOrderStates = new Set(["0", "1", "2", "3", "6", "8", "9", "12", "13", "14", "15"]);
const cancelledOrderStates = new Set(["4", "5", "7"]);

type Enrollment = NonNullable<LocalSession["xiaochanEnrollments"]>[string];

const positiveId = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return;
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) return;
  return text;
};

export async function fetchXiaochanEnrollmentUpdates(
  session: LocalSession,
  offers: Offer[],
  { rpc = xiaochanRpc, now = new Date() }: { rpc?: typeof xiaochanRpc; now?: Date } = {},
) {
  const updates: Record<string, Enrollment | null> = {};
  const errors: string[] = [];
  const tracked = offers.filter(offer => offer.source === "live" && session.xiaochanEnrollments?.[offer.id]);
  if (!tracked.length) return { updates, errors };
  const headers = xiaochanAccountHeaders(session.xiaochanAccount!);
  const confirmed = tracked.filter(offer => session.xiaochanEnrollments![offer.id]!.state !== "unknown");
  for (let offset = 0; offset < confirmed.length; offset += 20) {
    const batch = confirmed.slice(offset, offset + 20);
    try {
      const ids = batch.map(offer => positiveId(session.xiaochanEnrollments![offer.id]!.orderId));
      if (ids.some(id => !id)) throw new Error("Invalid saved order");
      const result = await rpc({
        headers, serverName: "Silkworm", methodName: "SilkwormService.GetPromotionOrderList",
        location: session.location,
        body: { silk_id: Number(session.xiaochanAccount!.silkId), ids: ids.map(Number), number: 20 },
      });
      if (!result?.status || ![0, "0"].includes(result.status.code) || !Array.isArray(result.order_list))
        throw new Error("Invalid order list");
      for (const offer of batch) {
        const previous = session.xiaochanEnrollments![offer.id]!;
        const matching = result.order_list.filter((order: any) =>
          positiveId(order.promotion_order_id) === previous.orderId && [1, "1"].includes(order.store_platform),
        );
        if (matching.length !== 1) {
          errors.push("小蚕报名状态同步失败，请重试");
          continue;
        }
        const state = String(matching[0].order_status);
        if (cancelledOrderStates.has(state)) updates[offer.id] = null;
        else if (confirmedOrderStates.has(state)) updates[offer.id] = { ...previous, updatedAt: now.toISOString() };
        else errors.push("小蚕报名状态同步失败，请重试");
      }
    } catch (error: any) {
      if (error.statusCode === 401) throw error;
      errors.push("小蚕报名状态同步失败，请重试");
    }
  }
  for (const offer of tracked.filter(offer => session.xiaochanEnrollments![offer.id]!.state === "unknown")) {
    try {
      const lookup = structuredClone(session);
      await enrollXiaochan(lookup, offer.id, { rpc, now, persist: async () => {} });
      updates[offer.id] = lookup.xiaochanEnrollments![offer.id]!;
    } catch (error: any) {
      if (error.statusCode === 401) throw error;
      errors.push("小蚕报名待确认");
    }
  }
  return { updates, errors: [...new Set(errors)] };
}

export function applyXiaochanEnrollmentUpdates(
  session: LocalSession,
  snapshot: LocalSession,
  updates: Record<string, Enrollment | null>,
) {
  for (const [offerId, enrollment] of Object.entries(updates)) {
    // A quota claimed after the sync snapshot must survive an older lookup response.
    if (JSON.stringify(session.xiaochanEnrollments?.[offerId]) !== JSON.stringify(snapshot.xiaochanEnrollments?.[offerId])) continue;
    if (enrollment) (session.xiaochanEnrollments ||= {})[offerId] = enrollment;
    else delete session.xiaochanEnrollments?.[offerId];
  }
}

export async function enrollXiaochan(
  session: LocalSession,
  input: unknown,
  { persist, rpc = xiaochanRpc, now = new Date() }: EnrollmentOptions,
) {
  const account = session.xiaochanAccount;
  if (!account || session.connections.xiaochan.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录小蚕" });
  if (!positiveId(account.silkId) || account.silkId.length > 12 ||
    !positiveId(account.userId) || !account.accessToken ||
    (account.expiresAt !== undefined && account.expiresAt <= now.getTime()))
    throw createError({ statusCode: 401, statusMessage: "小蚕登录已失效，请重新登录" });
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input))
    throw createError({ statusCode: 400, statusMessage: "请选择小蚕活动" });
  const promotionId = positiveId(input.slice("xiaochan:".length));
  if (!promotionId)
    throw createError({ statusCode: 400, statusMessage: "请选择小蚕活动" });
  const offer = session.offers.xiaochan.find(row => row.id === input);
  if (!offer || offer.provider !== "xiaochan" || offer.source !== "live")
    throw createError({ statusCode: 404, statusMessage: "活动已更新，请重新同步" });
  const previous = session.xiaochanEnrollments?.[input];
  if (previous?.state === "enrolled") return previous;
  if (previous?.state === "cancel-unknown")
    throw createError({ statusCode: 409, statusMessage: "取消待确认" });
  if (previous?.state === "unknown") {
    let detail: any;
    try {
      detail = await rpc({
        headers: xiaochanAccountHeaders(account),
        serverName: "Silkworm",
        methodName: "SilkwormService.GetStorePromotionDetail",
        location: session.location,
        body: { silk_id: Number(account.silkId), promotion_id: Number(promotionId) },
      });
    } catch (error: any) {
      if (error.statusCode === 401 && error?.data?.xiaochanOutcome === "rejected") {
        session.connections.xiaochan = { ...session.connections.xiaochan, state: "expired", label: "登录已失效" };
        await persist();
        throw error;
      }
      throw createError({ statusCode: 409, statusMessage: "报名待确认" });
    }
    const matching = Array.isArray(detail?.order_list) ? detail.order_list.filter((order: any) =>
      [1, "1"].includes(order.store_platform) && positiveId(order.promotion_order_id) &&
      confirmedOrderStates.has(String(order.order_status)),
    ) : [];
    const orderId = matching.length === 1 ? positiveId(matching[0].promotion_order_id) : undefined;
    if (!detail?.status || ![0, "0"].includes(detail.status.code) ||
      positiveId(detail.promotion_detail?.promotion_id) !== promotionId ||
      ![1, "1"].includes(detail.promotion_detail?.meituan_status) || !orderId)
      throw createError({ statusCode: 409, statusMessage: "报名待确认" });
    const enrolled = { state: "enrolled" as const, orderId, updatedAt: now.toISOString() };
    session.xiaochanEnrollments![input] = enrolled;
    await persist();
    return enrolled;
  }
  const location = session.location;
  if (!location)
    throw createError({ statusCode: 400, statusMessage: "请先设置收餐地址" });
  if (!activeAt(offer, now) || !Number.isSafeInteger(offer.inventory) || (offer.inventory ?? 0) <= 0 ||
    !offerWithinRadius(offer, COMPARISON_RADIUS_METERS))
    throw createError({ statusCode: 409, statusMessage: "活动暂不可报名" });

  const enrollments = session.xiaochanEnrollments ||= {};
  const pending = { state: "unknown" as const, updatedAt: now.toISOString() };
  enrollments[input] = pending;
  // Persist the attempt before requesting quota so an interrupted request cannot be resubmitted.
  try {
    await persist();
  } catch (error) {
    delete enrollments[input];
    throw error;
  }
  let result: any;
  try {
    result = await rpc({
      headers: xiaochanAccountHeaders(account),
      serverName: "Silkworm",
      methodName: "SilkwormService.GrabPromotionQuota",
      location,
      body: {
        silk_id: Number(account.silkId),
        promotion_id: Number(promotionId),
        store_platform: 1,
        if_advance_order: false,
        if_pre_order: false,
        city_code: location.cityCode,
        longitude: location.longitude,
        latitude: location.latitude,
      },
    });
  } catch (error: any) {
    if (error?.data?.xiaochanOutcome === "rejected") {
      delete enrollments[input];
      if (error.statusCode === 401)
        session.connections.xiaochan = { ...session.connections.xiaochan, state: "expired", label: "登录已失效" };
      await persist();
      throw error;
    }
    throw createError({ statusCode: 502, statusMessage: "报名待确认" });
  }
  const orderId = positiveId(result?.promotion_order_id);
  if (!result?.status || ![0, "0"].includes(result.status.code) || !orderId)
    throw createError({ statusCode: 502, statusMessage: "报名待确认" });
  const enrolled = { state: "enrolled" as const, orderId, updatedAt: new Date().toISOString() };
  enrollments[input] = enrolled;
  await persist();
  return enrolled;
}

export async function cancelXiaochanEnrollment(
  session: LocalSession,
  input: unknown,
  { persist, rpc = xiaochanRpc, now = new Date() }: EnrollmentOptions,
) {
  const account = session.xiaochanAccount;
  if (!account || session.connections.xiaochan.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录小蚕" });
  const headers = xiaochanAccountHeaders(account);
  if (typeof input !== "string" || !/^xiaochan:[1-9]\d*$/.test(input))
    throw createError({ statusCode: 400, statusMessage: "请选择小蚕活动" });
  const previous = session.xiaochanEnrollments?.[input];
  const orderId = positiveId(previous?.orderId);
  if (!previous || previous.state === "unknown" || !orderId)
    throw createError({ statusCode: 409, statusMessage: "暂无可取消的报名" });
  const lookup = async () => {
    const result = await rpc({
      headers, serverName: "Silkworm", methodName: "SilkwormService.GetPromotionOrderList",
      location: session.location,
      body: { silk_id: Number(account.silkId), ids: [Number(orderId)], number: 20 },
    });
    const matching = Array.isArray(result?.order_list) ? result.order_list.filter((order: any) =>
      positiveId(order.promotion_order_id) === orderId && [1, "1"].includes(order.store_platform),
    ) : [];
    if (!result?.status || ![0, "0"].includes(result.status.code) || matching.length !== 1)
      throw createError({ statusCode: 409, statusMessage: "取消待确认" });
    return String(matching[0].order_status);
  };
  const clear = async () => {
    const schedule = session.xiaochanSchedules?.[input];
    delete session.xiaochanEnrollments![input];
    delete session.xiaochanSchedules?.[input];
    try { await persist(); } catch (error) {
      session.xiaochanEnrollments![input] = previous;
      if (schedule) (session.xiaochanSchedules ||= {})[input] = schedule;
      throw error;
    }
  };
  try {
    const state = await lookup();
    if (cancelledOrderStates.has(state)) return await clear();
    if (previous.state === "cancel-unknown")
      throw createError({ statusCode: 409, statusMessage: "取消待确认" });
    if (state !== "0")
      throw createError({ statusCode: 409, statusMessage: "当前报名不可取消" });
    session.xiaochanEnrollments![input] = { ...previous, state: "cancel-unknown", updatedAt: now.toISOString() };
    try {
      await persist();
    } catch (error) {
      session.xiaochanEnrollments![input] = previous;
      throw error;
    }
    try {
      const result = await rpc({
        headers, serverName: "Silkworm", methodName: "SilkwormService.CancelPromotionQuota",
        location: session.location,
        body: { silk_id: Number(account.silkId), promotion_order_id: Number(orderId) },
      });
      if (!result?.status || ![0, "0"].includes(result.status.code))
        throw createError({ statusCode: 502, statusMessage: "取消待确认" });
    } catch (error: any) {
      if (error?.data?.xiaochanOutcome === "rejected") {
        session.xiaochanEnrollments![input] = previous;
        await persist();
        throw error;
      }
      // A lost response can still be resolved by the official order state.
    }
    if (cancelledOrderStates.has(await lookup())) return await clear();
    throw createError({ statusCode: 409, statusMessage: "取消待确认" });
  } catch (error: any) {
    if (error.statusCode === 401) {
      session.connections.xiaochan = { ...session.connections.xiaochan, state: "expired", label: "登录已失效" };
      await persist();
    }
    throw error;
  }
}
