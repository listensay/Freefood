import { createError } from "h3";
import type { Offer } from "../../shared/types";
import { activeAt } from "../../shared/utils/pricing";
import { COMPARISON_RADIUS_METERS, offerWithinRadius } from "../../shared/utils/scope";
import type { LocalSession } from "./session";
import { assertWaimaiAccount, prepareWaimaiSignup, waimaiOrderRequest } from "./waimai";

interface EnrollmentOptions {
  persist: () => Promise<void>;
  transport?: typeof fetch;
  now?: Date;
}
type Enrollment = NonNullable<LocalSession["waimaiEnrollments"]>[string];
const confirmedStates = new Set(["buy_signup", "buy_underreview", "buy_audited", "buy_completed", "buy_auditfailed"]);
const endedStates = new Set(["buy_cancelled", "buy_expired", "buy_invalid", "buy_auditfailed_two"]);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const pendingError = (cancel = false) => createError({ statusCode: 409, statusMessage: cancel ? "取消待确认" : "报名待确认" });

function target(input: unknown) {
  if (typeof input !== "string" || !/^waimai:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/.test(input))
    throw createError({ statusCode: 400, statusMessage: "请选择歪麦活动" });
  const [, businessId, overbearfoodId] = input.split(":") as [string, string, string];
  return { offerId: input, businessId, overbearfoodId };
}
function connectedAccount(session: LocalSession) {
  if (!session.waimaiAccount || session.connections.waimai.state !== "connected")
    throw createError({ statusCode: 401, statusMessage: "请先登录歪麦" });
  assertWaimaiAccount(session.waimaiAccount);
  return session.waimaiAccount;
}
async function expire(session: LocalSession, error: any, persist: () => Promise<void>) {
  if (error.statusCode !== 401) return;
  session.connections.waimai = { ...session.connections.waimai, state: "expired", label: "登录已失效" };
  await persist();
}

// Only official records matching the selected shop, tier and platform can settle an attempt.
async function lookupOrders(session: LocalSession, transport: typeof fetch, wanted: Set<string>) {
  const account = connectedAccount(session);
  const orders = new Map<string, any>();
  for (let page = 1; page <= 100; page++) {
    if (page > 1) await new Promise(resolve => setTimeout(resolve, 600));
    const result = await waimaiOrderRequest(account, session.location?.cityName || "", "api_overbear_orders_list", {
      page, limit: 10, queryDataType: "query_data_all", userId: account.userId, channelId: "",
    }, transport);
    if (result.data == null && [0, "0"].includes(result.count)) result.data = [];
    if (!Array.isArray(result.data) || !["number", "string"].includes(typeof result.count) ||
      !/^\d+$/.test(String(result.count)) || !Number.isSafeInteger(Number(result.count)) || Number(result.count) < 0)
      throw createError({ statusCode: 502, statusMessage: "歪麦报名状态无法解析，请重试" });
    let added = 0;
    for (const order of result.data) {
      if (!identifier(order?.buyOverbearfoodId))
        throw createError({ statusCode: 502, statusMessage: "歪麦报名状态无法解析，请重试" });
      if (!orders.has(order.buyOverbearfoodId)) added++;
      orders.set(order.buyOverbearfoodId, order);
    }
    if (wanted.size && [...wanted].every(id => orders.has(id))) return [...orders.values()];
    if (orders.size >= Number(result.count)) return [...orders.values()];
    if (!result.data.length || !added) break;
  }
  throw createError({ statusCode: 502, statusMessage: "歪麦报名状态未加载完整，请重试" });
}
function matchingOrders(orders: any[], selected: ReturnType<typeof target>, orderId?: string) {
  return orders.filter(order => order.businessId === selected.businessId && order.overbearfoodId === selected.overbearfoodId &&
    order.platform === "meituan" && order.type === "overbear_food" &&
    (!orderId || order.buyOverbearfoodId === orderId));
}
function currentOrder(orders: any[], selected: ReturnType<typeof target>, previous?: Enrollment) {
  const matches = matchingOrders(orders, selected, previous?.orderId);
  const active = matches.filter(order => !endedStates.has(order.status));
  if (active.length > 1 || (previous?.orderId && matches.length !== 1)) throw pendingError(previous?.state === "cancel-unknown");
  return previous?.orderId ? matches[0] : active[0];
}

export async function enrollWaimai(session: LocalSession, input: unknown, {
  persist, transport = fetch, now = new Date(),
}: EnrollmentOptions) {
  const account = connectedAccount(session);
  const selected = target(input);
  const previous = session.waimaiEnrollments?.[selected.offerId];
  if (previous?.state === "enrolled") return previous;
  if (previous?.state === "cancel-unknown") throw pendingError(true);
  const offer = session.offers.waimai.find(row => row.id === input);
  if (!previous && (!offer || offer.provider !== "waimai" || offer.source !== "live" || offer.enrollmentAvailable !== true))
    throw createError({ statusCode: 404, statusMessage: "活动已更新，请重新同步" });
  const location = session.location;
  if (!previous && (!location || !location.cityName))
    throw createError({ statusCode: 400, statusMessage: "请先设置收餐地址和城市名称" });
  if (!previous && (!activeAt(offer!, now) || !Number.isSafeInteger(offer!.inventory) || (offer!.inventory ?? 0) <= 0 ||
    !offerWithinRadius(offer!, COMPARISON_RADIUS_METERS)))
    throw createError({ statusCode: 409, statusMessage: "活动暂不可报名" });
  const saveConfirmed = async (orderId: string) => {
    const enrolled = { state: "enrolled" as const, orderId, updatedAt: now.toISOString() };
    (session.waimaiEnrollments ||= {})[selected.offerId] = enrolled;
    await persist();
    return enrolled;
  };
  try {
    const orders = await lookupOrders(session, transport, new Set(previous?.orderId ? [previous.orderId] : []));
    const order = currentOrder(orders, selected, previous);
    if (order && confirmedStates.has(order.status)) return await saveConfirmed(order.buyOverbearfoodId);
    if (order?.status === "wait_payment") {
      (session.waimaiEnrollments ||= {})[selected.offerId] = {
        state: "unknown", orderId: order.buyOverbearfoodId, updatedAt: now.toISOString(),
      };
      await persist();
      throw createError({ statusCode: 409, statusMessage: "请在歪麦完成支付或取消报名" });
    }
    // Missing or unrecognized records cannot prove that a timed-out signup was rejected.
    if (previous || order) throw pendingError();
    const signup = await prepareWaimaiSignup(account, location!.cityName!, transport);
    const enrollments = session.waimaiEnrollments ||= {};
    enrollments[selected.offerId] = { state: "unknown", updatedAt: now.toISOString() };
    try { await persist(); } catch (error) {
      delete enrollments[selected.offerId];
      throw error;
    }
    let result: any;
    try {
      result = await signup({
        businessId: selected.businessId, buyChannel: "autonomy", overbearfoodId: selected.overbearfoodId,
        serviceNoStr: "api_overbear_sign_up", shareUserId: "", shareLongitude: "", shareLatitude: "",
        city: location!.cityName, shareRecordId: "", type: "overbear_one",
        userId: account.userId, redIds: [], orderSourcePage: "MEAL_DETAIL",
      });
    } catch (error: any) {
      if (error.data?.waimaiOutcome === "rejected") {
        delete enrollments[selected.offerId];
        await persist();
        throw error;
      }
      throw pendingError();
    }
    const orderId = result?.data?.buyOverbearId;
    if (!identifier(orderId)) throw pendingError();
    // A paid reservation is not an enrollment. Never invoke the payment endpoints.
    enrollments[selected.offerId] = { state: "unknown", orderId, updatedAt: now.toISOString() };
    await persist();
    if (Number(result.data.occupyFlag) === 1 || Number(result.data.secKillFlag) === 1 ||
      Number(result.data.payAmount || 0) > 0 || result.data.payMoneyToCompanyOutDto || result.data.payUnifiedOrderOutDto)
      throw createError({ statusCode: 409, statusMessage: "请在歪麦完成支付或取消报名" });
    const confirmed = currentOrder(await lookupOrders(session, transport, new Set([orderId])), selected, enrollments[selected.offerId]);
    if (!confirmed || !confirmedStates.has(confirmed.status)) throw pendingError();
    return await saveConfirmed(orderId);
  } catch (error: any) {
    await expire(session, error, persist);
    throw error;
  }
}

export async function cancelWaimaiEnrollment(session: LocalSession, input: unknown, {
  persist, transport = fetch, now = new Date(),
}: EnrollmentOptions) {
  const account = connectedAccount(session);
  const selected = target(input);
  const previous = session.waimaiEnrollments?.[selected.offerId];
  if (!previous || !identifier(previous.orderId))
    throw createError({ statusCode: 409, statusMessage: "暂无可取消的报名" });
  const lookup = async () => currentOrder(await lookupOrders(session, transport, new Set([previous.orderId!])), selected, previous);
  const clear = async () => {
    const schedule = session.waimaiSchedules?.[selected.offerId];
    delete session.waimaiEnrollments![selected.offerId];
    delete session.waimaiSchedules?.[selected.offerId];
    try { await persist(); } catch (error) {
      session.waimaiEnrollments![selected.offerId] = previous;
      if (schedule) (session.waimaiSchedules ||= {})[selected.offerId] = schedule;
      throw error;
    }
  };
  try {
    const order = await lookup();
    if (order && endedStates.has(order.status)) return await clear();
    if (previous.state === "cancel-unknown") throw pendingError(true);
    if (!order || !["buy_signup", "wait_payment"].includes(order.status) || !identifier(order.serviceId))
      throw createError({ statusCode: 409, statusMessage: "当前报名不可取消" });
    session.waimaiEnrollments![selected.offerId] = { ...previous, state: "cancel-unknown", updatedAt: now.toISOString() };
    try { await persist(); } catch (error) {
      session.waimaiEnrollments![selected.offerId] = previous;
      throw error;
    }
    try {
      await waimaiOrderRequest(account, session.location?.cityName || "", "api_overbear_cancel_sign_up", {
        userId: account.userId, buyOverbearfoodId: previous.orderId, overbearfoodId: order.overbearfoodId,
        serviceId: order.serviceId, type: order.type, status: "buy_cancelled",
      }, transport);
    } catch (error: any) {
      if (error.data?.waimaiOutcome === "rejected") {
        session.waimaiEnrollments![selected.offerId] = previous;
        await persist();
        throw error;
      }
    }
    const cancelled = await lookup();
    if (cancelled && endedStates.has(cancelled.status)) return await clear();
    throw pendingError(true);
  } catch (error: any) {
    await expire(session, error, persist);
    throw error;
  }
}

export async function fetchWaimaiEnrollmentUpdates(session: LocalSession, _offers: Offer[], {
  transport = fetch, now = new Date(),
}: { transport?: typeof fetch; now?: Date } = {}) {
  const updates: Record<string, Enrollment | null> = {};
  const errors: string[] = [];
  const tracked = Object.entries(session.waimaiEnrollments || {});
  if (!tracked.length) return { updates, errors };
  try {
    const wanted = tracked.every(([, enrollment]) => enrollment.orderId)
      ? new Set(tracked.map(([, enrollment]) => enrollment.orderId!)) : new Set<string>();
    const orders = await lookupOrders(session, transport, wanted);
    for (const [offerId, previous] of tracked) {
      try {
        const order = currentOrder(orders, target(offerId), previous);
        if (!order) throw pendingError();
        if (endedStates.has(order.status)) updates[offerId] = null;
        else if (confirmedStates.has(order.status)) updates[offerId] = {
          state: previous.state === "cancel-unknown" ? "cancel-unknown" : "enrolled",
          orderId: order.buyOverbearfoodId, updatedAt: now.toISOString(),
        };
        else if (order.status === "wait_payment") {
          updates[offerId] = {
            state: previous.state === "cancel-unknown" ? "cancel-unknown" : "unknown",
            orderId: order.buyOverbearfoodId, updatedAt: now.toISOString(),
          };
          errors.push("请在歪麦完成支付或取消报名");
        }
        else throw pendingError(previous.state === "cancel-unknown");
      } catch { errors.push("歪麦报名状态待确认"); }
    }
  } catch (error: any) {
    if (error.statusCode === 401) throw error;
    errors.push("歪麦报名状态同步失败，请重试");
  }
  return { updates, errors: [...new Set(errors)] };
}

export function applyWaimaiEnrollmentUpdates(session: LocalSession, snapshot: LocalSession, updates: Record<string, Enrollment | null>) {
  for (const [offerId, enrollment] of Object.entries(updates)) {
    if (JSON.stringify(session.waimaiEnrollments?.[offerId]) !== JSON.stringify(snapshot.waimaiEnrollments?.[offerId])) continue;
    if (enrollment) (session.waimaiEnrollments ||= {})[offerId] = enrollment;
    else delete session.waimaiEnrollments?.[offerId];
  }
}
