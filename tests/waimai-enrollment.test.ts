import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { applyWaimaiEnrollmentUpdates, cancelWaimaiEnrollment, enrollWaimai, fetchWaimaiEnrollmentUpdates } from "../server/utils/waimai-enrollment";
import { normalizeWaimai, prepareWaimaiSignup, waimaiOrderRequest } from "../server/utils/waimai";
import { emptySession, type LocalSession } from "../server/utils/session";
import { createWaimaiTransport, waimaiTestAccount, waimaiTestLocation } from "./fixtures/waimai-enrollment";

const now = new Date("2026-11-07T04:00:00Z");
const offerId = "waimai:shop-42:sku-43";
const order = (overrides: Record<string, unknown> = {}) => ({
  buyOverbearfoodId: "order-1", overbearfoodId: "sku-43", businessId: "shop-42",
  platform: "meituan", type: "overbear_food", serviceId: "service-1", status: "buy_signup", ...overrides,
});
const listing = (rows: unknown[] = [], count: number | string = rows.length) => ({ code: 1, data: rows, count });
const signupResult = (data: Record<string, unknown> = {}) => ({ code: 200, data: { buyOverbearId: "order-1", ...data } });
function session(): LocalSession {
  const data = emptySession();
  data.waimaiAccount = { ...waimaiTestAccount };
  data.connections.waimai = { state: "connected", label: "已登录" };
  data.location = { ...waimaiTestLocation };
  data.offers.waimai = [{
    id: offerId, provider: "waimai", name: "测试店", category: "美食", enrollmentAvailable: true,
    source: "live", collectedAt: now.toISOString(), inventory: 3, distanceMeters: 1000,
    startTime: "08:00", endTime: "23:59", requirement: "无需评价",
    rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
  }];
  return data;
}
function saved(state: "enrolled" | "unknown" | "cancel-unknown" = "enrolled", orderId: string | null = "order-1") {
  const data = session();
  data.waimaiEnrollments = { [offerId]: { state, ...(orderId ? { orderId } : {}), updatedAt: now.toISOString() } };
  return data;
}

test("Waimai enrollment uses the mini-program encrypted contract and persists before claiming quota", async () => {
  const data = session();
  const events: string[] = [];
  let lookups = 0;
  const { transport, calls } = createWaimaiTransport(request => {
    events.push(request.operation);
    if (request.operation === "list") {
      assert.deepEqual(request.body, { page: 1, limit: 10, queryDataType: "query_data_all", userId: waimaiTestAccount.userId,
        channelId: "", serviceNoStr: "api_overbear_orders_list" });
      return listing(++lookups === 1 ? [] : [order()]);
    }
    assert.equal(request.operation, "signup");
    assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
    assert.equal(events.at(-2), "persist:unknown");
    assert.deepEqual(request.body, {
      businessId: "shop-42", buyChannel: "autonomy", overbearfoodId: "sku-43", serviceNoStr: "api_overbear_sign_up",
      shareUserId: "", shareLongitude: "", shareLatitude: "", city: "上海市", shareRecordId: "",
      type: "overbear_one", userId: waimaiTestAccount.userId, redIds: [], orderSourcePage: "MEAL_DETAIL",
    });
    return signupResult();
  });
  const result = await enrollWaimai(data, offerId, { now, transport, persist: async () => {
    events.push(`persist:${data.waimaiEnrollments?.[offerId]?.state}`);
  } });
  assert.equal(result.state, "enrolled");
  assert.equal(result.orderId, "order-1");
  assert.deepEqual(calls.map(call => call.operation), ["list", "config", "signup", "list"]);
  assert.deepEqual(events, ["list", "persist:unknown", "signup", "persist:unknown", "list", "persist:enrolled"]);
  await enrollWaimai(data, offerId, { now, transport: async () => { assert.fail("Repeated quota request"); }, persist: async () => {} });
});

test("Waimai rejects guests, imported or unsupported activities and invalid scope before requests", async () => {
  const cases: Array<(data: LocalSession) => void> = [
    data => { delete data.waimaiAccount; },
    data => { data.waimaiAccount!.token = "bad\r\nheader"; },
    data => { data.connections.waimai.state = "expired"; },
    data => { data.offers.waimai[0]!.source = "import"; },
    data => { data.offers.waimai[0]!.provider = "xiaochan"; },
    data => { data.offers.waimai[0]!.enrollmentAvailable = false; },
    data => { delete data.offers.waimai[0]!.enrollmentAvailable; },
    data => { data.offers.waimai[0]!.inventory = 0; },
    data => { data.offers.waimai[0]!.inventory = 1.5; },
    data => { delete data.offers.waimai[0]!.inventory; },
    data => { data.offers.waimai[0]!.distanceMeters = 7001; },
    data => { delete data.offers.waimai[0]!.distanceMeters; },
    data => { data.offers.waimai[0]!.collectedAt = "2026-11-06T04:00:00Z"; },
    data => { data.offers.waimai[0]!.startTime = "13:00"; },
    data => { data.offers.waimai[0]!.validUntil = now.toISOString(); },
    data => { data.location = null; },
    data => { delete data.location!.cityName; },
  ];
  let requests = 0, persists = 0;
  const options = { now, persist: async () => { persists++; }, transport: (async () => {
    requests++; throw new Error("Unexpected upstream request");
  }) as typeof fetch };
  for (const change of cases) {
    const data = session(); change(data);
    await assert.rejects(enrollWaimai(data, offerId, options));
  }
  for (const input of [undefined, {}, "xiaochan:42", "waimai:shop-42", "waimai:shop-42:sku/43", "waimai:shop-42:missing", `waimai:${"a".repeat(129)}:sku-43`])
    await assert.rejects(enrollWaimai(session(), input, options));
  assert.equal(requests, 0);
  assert.equal(persists, 0);
});

test("Waimai normalization preserves the package ID and only enables ordinary supported signup", () => {
  const row = { id: "shop-42", shopName: "测试店", shopPlatformType: 1, distance: "1km", overbearfoodList: [{
    id: "feed-sku", overbearFoodId: "actual-package", takeawayPlatform: "meituan", surplusNumber: 3,
    maxGradeRebate: { fullMoney: "20", rebateMoney: "15" },
  }] };
  const offers = normalizeWaimai({ data: { data: [row, { ...row, id: "ele-shop", shopPlatformType: 3 }] } });
  assert.equal(offers[0]!.id, "waimai:shop-42:actual-package");
  assert.equal(offers[0]!.enrollmentAvailable, true);
  assert.equal(offers[1]!.enrollmentAvailable, false);
});

test("Waimai never sends signup if persisting the pending attempt fails", async () => {
  const data = session();
  const { transport, calls } = createWaimaiTransport(() => listing());
  await assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => { throw new Error("disk failed"); } }), /disk failed/);
  assert.equal(calls.filter(call => call.operation === "signup").length, 0);
  assert.equal(data.waimaiEnrollments?.[offerId], undefined);
});

test("Waimai resolves an existing matching order without submitting another signup", async () => {
  for (const previous of [false, true]) {
    const data = previous ? saved("unknown", null) : session();
    if (previous) { data.offers.waimai = []; data.location = null; }
    const { transport, calls } = createWaimaiTransport(() => listing([order()]), { city: previous ? "" : waimaiTestLocation.cityName });
    const result = await enrollWaimai(data, offerId, { now, transport, persist: async () => {} });
    assert.equal(result.state, "enrolled");
    assert.deepEqual(calls.map(call => call.operation), ["list"]);
  }
});

test("Waimai confirms signup only using the exact saved order, shop, package and ordinary Meituan platform", async () => {
  const mismatches = [
    { buyOverbearfoodId: "other-order" }, { businessId: "other-shop" }, { overbearfoodId: "other-package" },
    { platform: "ele" }, { type: "meituan_overbear_food" }, { status: "wait_payment" },
    { status: "future_status" }, { status: "buy_cancelled" },
  ];
  for (const mismatch of mismatches) {
    const data = session(); let lists = 0;
    const { transport, calls } = createWaimaiTransport(request => request.operation === "signup" ? signupResult()
      : listing(++lists === 1 ? [] : [order(mismatch)]));
    await assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => {} }));
    assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
    assert.equal(calls.filter(call => call.operation === "signup").length, 1);
  }
});

test("Waimai ambiguous active records never confirm an unknown attempt", async () => {
  const data = saved("unknown", null);
  const { transport, calls } = createWaimaiTransport(() => listing([order(), order({ buyOverbearfoodId: "order-2" })]));
  await assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => {} }), /报名待确认/);
  assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
  assert.deepEqual(calls.map(call => call.operation), ["list"]);
});

test("Waimai lost or malformed signup responses stay pending and repeat actions only query", async () => {
  for (const response of [null, {}, { code: null, data: { buyOverbearId: "order-1" } }, { code: 200, data: {} },
    { code: 200, data: { buyOverbearId: 42 } },
    ...[500, 503, 99999, [], [-3], {}, true, "", 1.5].map(code => ({ code, message: "private-response" })),
    new Response("bad JSON"), new Response("upstream unavailable", { status: 503 }), "throw"]) {
    const data = session();
    const { transport, calls } = createWaimaiTransport(request => {
      if (request.operation === "list") return listing();
      if (response === "throw") throw new Error("private network failure");
      return response;
    });
    const options = { now, transport, persist: async () => {} };
    await assert.rejects(enrollWaimai(data, offerId, options), /报名待确认/);
    await assert.rejects(enrollWaimai(data, offerId, options), /报名待确认/);
    assert.equal(calls.filter(call => call.operation === "signup").length, 1);
    assert.equal(calls.filter(call => call.operation === "list").length, 2);
    assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
    assert.equal(data.connections.waimai.state, "connected");
  }
});

test("Waimai fee and payment responses are not successful enrollments and never invoke payment", async () => {
  for (const payment of [{ payAmount: 5 }, { payAmount: "2.00" }, { occupyFlag: 1 }, { secKillFlag: "1" },
    { payMoneyToCompanyOutDto: { nonceStr: "payment" } }, { payUnifiedOrderOutDto: { totalFee: 5 } }]) {
    const data = session();
    const { transport, calls } = createWaimaiTransport(request => request.operation === "list" ? listing() : signupResult(payment));
    await assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => {} }), /完成支付或取消报名/);
    assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
    assert.equal(data.waimaiEnrollments?.[offerId]?.orderId, "order-1");
    assert.deepEqual(calls.map(call => call.operation), ["list", "config", "signup"]);
  }
});

test("Waimai explicit rejection clears the attempt and allows a later deliberate retry", async () => {
  for (const reject of [{ code: -1 }, { code: 13001 }, new Response("blocked", { status: 403 }), new Response("limited", { status: 429 })]) {
    const data = session();
    const { transport, calls } = createWaimaiTransport(request => request.operation === "list" ? listing() : reject);
    const options = { now, transport, persist: async () => {} };
    await assert.rejects(enrollWaimai(data, offerId, options));
    assert.equal(data.waimaiEnrollments?.[offerId], undefined);
    await assert.rejects(enrollWaimai(data, offerId, options));
    assert.equal(calls.filter(call => call.operation === "signup").length, 2);
  }
});

test("Waimai confirmed login expiry is persisted without exposing upstream details", async () => {
  const data = saved("unknown"); let persisted = 0;
  const { transport } = createWaimaiTransport(() => ({ code: -3, message: "private-token" }));
  await assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => { persisted++; } }), (error: any) =>
    error.statusCode === 401 && !error.message.includes("private-token"));
  assert.equal(data.connections.waimai.state, "expired");
  assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
  assert.equal(persisted, 1);
});

test("Waimai cancellation uses the saved official order and persists uncertainty before the mutation", async () => {
  const data = saved(); let lists = 0, persisted = 0;
  const { transport, calls } = createWaimaiTransport(request => {
    if (request.operation === "list") return listing([order({ status: ++lists === 1 ? "buy_signup" : "buy_cancelled" })]);
    assert.equal(request.operation, "cancel");
    assert.equal(persisted, 1);
    assert.equal(data.waimaiEnrollments?.[offerId]?.state, "cancel-unknown");
    assert.deepEqual(request.body, {
      userId: waimaiTestAccount.userId, buyOverbearfoodId: "order-1", overbearfoodId: "sku-43",
      serviceId: "service-1", type: "overbear_food", status: "buy_cancelled", serviceNoStr: "api_overbear_cancel_sign_up",
    });
    return { code: 1, data: {} };
  });
  await cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => { persisted++; } });
  assert.equal(data.waimaiEnrollments?.[offerId], undefined);
  assert.equal(persisted, 2);
  assert.deepEqual(calls.map(call => call.operation), ["list", "cancel", "list"]);
});

test("Waimai cancellation rejects another shop, package, platform, order or fulfilled state", async () => {
  for (const mismatch of [{ businessId: "other" }, { overbearfoodId: "other" }, { platform: "ele" }, { type: "ele_overbear_food" },
    { buyOverbearfoodId: "other" }, { serviceId: null }, { status: "buy_underreview" }, { status: "buy_completed" },
    { status: "buy_audited" }, { status: "future_status" }]) {
    const data = saved();
    const { transport, calls } = createWaimaiTransport(() => listing([order(mismatch)]));
    await assert.rejects(cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => {} }));
    assert.equal(calls.filter(call => call.operation === "cancel").length, 0);
    assert.equal(data.waimaiEnrollments?.[offerId]?.state, "enrolled");
  }
});

test("Waimai cancellation save failure does not send a mutation and preserves the enrollment", async () => {
  const data = saved();
  const { transport, calls } = createWaimaiTransport(() => listing([order()]));
  await assert.rejects(cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => { throw new Error("disk failed"); } }), /disk failed/);
  assert.equal(data.waimaiEnrollments?.[offerId]?.state, "enrolled");
  assert.equal(calls.filter(call => call.operation === "cancel").length, 0);
});

test("Waimai lost cancellation responses are resolved by lookup, never by replaying the mutation", async () => {
  for (const resolvedImmediately of [true, false]) {
    const data = saved(); let lists = 0;
    const { transport, calls } = createWaimaiTransport(request => {
      if (request.operation === "cancel") throw new Error("lost response");
      lists++;
      return listing([order({ status: lists >= (resolvedImmediately ? 2 : 3) ? "buy_cancelled" : "buy_signup" })]);
    });
    const options = { now, transport, persist: async () => {} };
    if (resolvedImmediately) await cancelWaimaiEnrollment(data, offerId, options);
    else {
      await assert.rejects(cancelWaimaiEnrollment(data, offerId, options), /取消待确认/);
      assert.equal(data.waimaiEnrollments?.[offerId]?.state, "cancel-unknown");
      await cancelWaimaiEnrollment(data, offerId, options);
    }
    assert.equal(data.waimaiEnrollments?.[offerId], undefined);
    assert.equal(calls.filter(call => call.operation === "cancel").length, 1);
  }
});

test("Waimai rejected cancellation restores the previous state; pending cancellation does not repeat", async () => {
  const data = saved();
  const { transport, calls } = createWaimaiTransport(request => request.operation === "cancel" ? { code: -1 } : listing([order()]));
  await assert.rejects(cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => {} }));
  assert.equal(data.waimaiEnrollments?.[offerId]?.state, "enrolled");
  data.waimaiEnrollments![offerId]!.state = "cancel-unknown";
  await assert.rejects(cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => {} }), /取消待确认/);
  assert.equal(calls.filter(call => call.operation === "cancel").length, 1);
});

test("Waimai unknown enrollment scans later pages before confirming, without a new signup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = saved("unknown", null);
  const { transport, calls } = createWaimaiTransport(request => {
    assert.equal(request.operation, "list");
    return request.body.page === 1
      ? listing([order({ buyOverbearfoodId: "unrelated", businessId: "another-shop" })], 2)
      : listing([order()], 2);
  });
  const pending = enrollWaimai(data, offerId, { now, transport, persist: async () => {} });
  await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(600);
  const result = await pending;
  assert.equal(result.state, "enrolled");
  assert.deepEqual(calls.map(call => call.body.page), [1, 2]);
});

test("Waimai missing, inconsistent or malformed order counts never authorize signup", async () => {
  for (const response of [{ code: 1, data: [] }, { code: 1, data: [], count: null }, { code: 1, data: [], count: -1 },
    { code: 1, data: [], count: "" }, { code: 1, data: [], count: 1 }, { code: 1, data: {}, count: 0 },
    { code: 1, data: [{ ...order(), buyOverbearfoodId: 42 }], count: 1 }]) {
    const data = session();
    const { transport, calls } = createWaimaiTransport(() => response);
    await assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => {} }));
    assert.deepEqual(calls.map(call => call.operation), ["list"]);
    assert.equal(data.waimaiEnrollments?.[offerId], undefined);
  }
});

test("Waimai submits only after every order page proves no existing matching order", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = session(); let lists = 0;
  const { transport, calls } = createWaimaiTransport(request => {
    if (request.operation === "signup") return signupResult();
    lists++;
    if (lists <= 2) return listing([order({ buyOverbearfoodId: `unrelated-${lists}`, businessId: "other-shop" })], 2);
    return listing([order()]);
  });
  const pending = enrollWaimai(data, offerId, { now, transport, persist: async () => {} });
  await setImmediate();
  assert.equal(calls.length, 1);
  assert.equal(data.waimaiEnrollments?.[offerId], undefined);
  t.mock.timers.tick(599);
  await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.state, "enrolled");
  assert.deepEqual(calls.map(call => call.operation), ["list", "list", "config", "signup", "list"]);
  assert.deepEqual(calls.filter(call => call.operation === "list").map(call => call.body.page), [1, 2, 1]);
});

test("Waimai truncated or stalled order pages never make a partial scan eligible for signup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stalled of [false, true]) {
    const data = session();
    const unrelated = order({ buyOverbearfoodId: "unrelated", businessId: "other-shop" });
    const { transport, calls } = createWaimaiTransport(request => listing(request.body.page === 1 || stalled ? [unrelated] : [], 2));
    const rejected = assert.rejects(enrollWaimai(data, offerId, { now, transport, persist: async () => {} }), /未加载完整/);
    await setImmediate();
    t.mock.timers.tick(600);
    await rejected;
    assert.deepEqual(calls.map(call => call.operation), ["list", "list"]);
    assert.equal(data.waimaiEnrollments?.[offerId], undefined);
  }
});

test("Waimai sync preserves cancellation uncertainty and old snapshots cannot overwrite newer enrollment", async () => {
  const data = saved("cancel-unknown"), snapshot = structuredClone(data);
  const { transport } = createWaimaiTransport(() => listing([order()]));
  const result = await fetchWaimaiEnrollmentUpdates(snapshot, snapshot.offers.waimai, { now, transport });
  assert.deepEqual(result.errors, []);
  assert.equal(result.updates[offerId]?.state, "cancel-unknown");
  data.waimaiEnrollments![offerId] = { state: "enrolled", orderId: "new-order", updatedAt: "2026-11-07T04:00:01Z" };
  applyWaimaiEnrollmentUpdates(data, snapshot, { [offerId]: null });
  assert.equal(data.waimaiEnrollments?.[offerId]?.orderId, "new-order");
  const current = structuredClone(data);
  applyWaimaiEnrollmentUpdates(data, current, { [offerId]: null });
  assert.equal(data.waimaiEnrollments?.[offerId], undefined);
});

test("Waimai sync clears matched ended orders but retains missing or mismatched records", async () => {
  for (const mismatch of [undefined, { businessId: "wrong" }, { status: "future_status" }]) {
    const data = saved();
    const { transport } = createWaimaiTransport(() => listing([order(mismatch || { status: "buy_cancelled" })]));
    const result = await fetchWaimaiEnrollmentUpdates(data, [], { now, transport });
    if (!mismatch) assert.equal(result.updates[offerId], null);
    else { assert.deepEqual(result.updates, {}); assert.ok(result.errors.length); }
  }
});

test("Waimai sync recovers a pending payment order ID without signup and allows its later cancellation", async () => {
  const data = saved("unknown", null), snapshot = structuredClone(data);
  let cancelled = false;
  const { transport, calls } = createWaimaiTransport(request => {
    if (request.operation === "list") return listing([order({ status: cancelled ? "buy_cancelled" : "wait_payment" })]);
    assert.equal(request.operation, "cancel");
    assert.equal(request.body.buyOverbearfoodId, "order-1");
    assert.equal(request.body.status, "buy_cancelled");
    cancelled = true;
    return { code: 1, data: {} };
  });
  const result = await fetchWaimaiEnrollmentUpdates(snapshot, [], { now, transport });
  assert.deepEqual(result.updates[offerId], { state: "unknown", orderId: "order-1", updatedAt: now.toISOString() });
  assert.deepEqual(result.errors, ["请在歪麦完成支付或取消报名"]);
  assert.deepEqual(calls.map(call => call.operation), ["list"]);
  applyWaimaiEnrollmentUpdates(data, snapshot, result.updates);
  assert.equal(data.waimaiEnrollments?.[offerId]?.state, "unknown");
  assert.equal(data.waimaiEnrollments?.[offerId]?.orderId, "order-1");
  await cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => {} });
  assert.equal(data.waimaiEnrollments?.[offerId], undefined);
  assert.deepEqual(calls.map(call => call.operation), ["list", "list", "cancel", "list"]);
});

test("Waimai payment sync keeps cancel-unknown and cannot enable another cancellation mutation", async () => {
  const data = saved("cancel-unknown"), snapshot = structuredClone(data);
  const { transport, calls } = createWaimaiTransport(() => listing([order({ status: "wait_payment" })]));
  const result = await fetchWaimaiEnrollmentUpdates(snapshot, [], { now, transport });
  assert.deepEqual(result.updates[offerId], { state: "cancel-unknown", orderId: "order-1", updatedAt: now.toISOString() });
  assert.deepEqual(result.errors, ["请在歪麦完成支付或取消报名"]);
  applyWaimaiEnrollmentUpdates(data, snapshot, result.updates);
  assert.equal(data.waimaiEnrollments?.[offerId]?.state, "cancel-unknown");
  await assert.rejects(cancelWaimaiEnrollment(data, offerId, { now, transport, persist: async () => {} }), /取消待确认/);
  assert.deepEqual(calls.map(call => call.operation), ["list", "list"]);
});

test("Waimai transports enforce endpoint contracts and classify uncertain versus rejected HTTP responses", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const { transport } = createWaimaiTransport(() => new Response("private-response", { status }));
    const signup = await prepareWaimaiSignup(waimaiTestAccount, "上海市", transport);
    await assert.rejects(signup({}), (error: any) => error.data.waimaiOutcome === ([401, 403, 429].includes(status) ? "rejected" : "unknown") &&
      !error.message.includes("private-response"));
    await assert.rejects(waimaiOrderRequest(waimaiTestAccount, "上海市", "api_overbear_cancel_sign_up", {}, transport), (error: any) =>
      error.data.waimaiOutcome === ([401, 403, 429].includes(status) ? "rejected" : "unknown"));
  }
});
