import "./fixtures/session-key";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSession } from "../server/utils/session";
import type { xiaochanRpc } from "../server/utils/xiaochan-rpc";
import { activeAt } from "../shared/utils/pricing";

const directory = await mkdtemp(join(tmpdir(), "food-xiaochan-advance-"));
const previousDirectory = process.env.FOOD_DATA_DIR;
process.env.FOOD_DATA_DIR = directory;
const { emptySession, saveSession, publicSession } = await import("../server/utils/session");
const { getXiaochanScheduleOptions } = await import("../server/utils/xiaochan-advance");
const { createXiaochanSchedule, runXiaochanSchedule, cancelXiaochanSchedule } = await import("../server/utils/xiaochan-schedules");
const { enrollXiaochan } = await import("../server/utils/xiaochan-enrollment");
const time = (clock: string) => new Date(`2026-11-07T${clock}+08:00`);
const now = time("09:00:00");
const offerId = "xiaochan:42";
let nextAccount = 100000;
function session(): LocalSession {
  const data = emptySession();
  data.xiaochanAccount = { silkId: String(nextAccount++), userId: "6789", accessToken: "test-token" };
  data.connections.xiaochan = { state: "connected", label: "已登录" };
  data.location = { label: "测试地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 };
  data.offers.xiaochan = [{
    id: offerId, provider: "xiaochan", name: "测试活动", category: "美食", inventory: 3, distanceMeters: 1000,
    startTime: "10:00", endTime: "23:00", source: "live", collectedAt: now.toISOString(),
    validFrom: time("10:00:00").toISOString(), validUntil: time("23:00:00").toISOString(),
    requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
  }];
  return data;
}
const persist = async () => {};
const card = (id = 1, expiry = "11:00:00") => ({ id, expire_time: time(expiry).getTime() / 1000, card: { card_type: 1 } });
function upstream() {
  const state = { cards: [card()] as any[], detail: {} as Record<string, unknown>, failGrab: false, requests: [] as Parameters<typeof xiaochanRpc>[0][] };
  const rpc = (async request => {
    state.requests.push(request);
    if (request.methodName === "SilkwormService.GetStorePromotionDetail") return {
      status: { code: 0 }, promotion_detail: {
        promotion_id: request.body.promotion_id, meituan_status: 1, start_time_hour: 10, start_time_minute: 0, ...state.detail,
      },
    };
    if (request.methodName === "SilkwormCardService.GetUserCardList") return { status: { code: 0 }, list: state.cards };
    assert.equal(request.methodName, "SilkwormService.GrabPromotionQuota");
    if (state.failGrab) throw new Error("Response lost");
    return { status: { code: 0 }, promotion_order_id: 9042 };
  }) as typeof xiaochanRpc;
  return { state, rpc };
}
const grabs = (mock: ReturnType<typeof upstream>) => mock.state.requests.filter(row => row.methodName.endsWith("GrabPromotionQuota"));
const create = (data: LocalSession, mock: ReturnType<typeof upstream>, clock = "09:30:00", id = offerId) =>
  createXiaochanSchedule(data, id, time(clock).toISOString(), { now, persist, rpc: mock.rpc });

test("Advance options expose only the valid 30-minute window and preserve original pricing dates", async () => {
  const data = session(), mock = upstream(), original = structuredClone(data.offers);
  const result = await getXiaochanScheduleOptions(data, offerId, { now, rpc: mock.rpc });
  assert.deepEqual(result, { offerId, advanceWindows: [{ start: time("09:30:00").getTime(), end: time("10:00:00").getTime() }] });
  assert.deepEqual(data.offers, original);
  assert.equal(activeAt(data.offers.xiaochan[0]!, time("09:30:00")), false);
  assert.equal(JSON.stringify(result).includes("expire_time"), false);
  assert.equal(grabs(mock).length, 0);
});

test("Coupon expiry ends the early interval without opening the gap before ordinary enrollment", async () => {
  const data = session(), mock = upstream(); mock.state.cards = [card(1, "09:45:00")];
  const result = await getXiaochanScheduleOptions(data, offerId, { now, rpc: mock.rpc });
  assert.deepEqual(result.advanceWindows, [{ start: time("09:30:00").getTime(), end: time("09:45:00").getTime() }]);
  await assert.rejects(create(data, mock, "09:45:00"), /超前抢单券不足/);
  await assert.rejects(create(data, mock, "09:50:00"), /超前抢单券不足/);
  const before = mock.state.requests.length;
  await create(data, mock, "10:00:00");
  assert.equal(mock.state.requests.length, before);
  assert.equal(data.xiaochanSchedules![offerId]!.advanceOrder, undefined);
});

test("No valid coupons means no early window and no early reservation", async () => {
  for (const cards of [[], [card(1, "09:00:00")], [{ ...card(), status: 1 }], [{ ...card(), card: { card_type: 2 } }]]) {
    const data = session(), mock = upstream(); mock.state.cards = cards;
    assert.deepEqual((await getXiaochanScheduleOptions(data, offerId, { now, rpc: mock.rpc })).advanceWindows, []);
    await assert.rejects(create(data, mock), /超前抢单券不足/);
    assert.equal(data.xiaochanSchedules?.[offerId], undefined);
  }
});

test("Exact 09:30 for a 10:00 opening is accepted while earlier, past and other-day times are rejected", async () => {
  const data = session(), mock = upstream();
  for (const runAt of [time("09:29:59.999").toISOString(), now.toISOString(), "invalid", "2026-11-08T09:30:00+08:00"])
    await assert.rejects(createXiaochanSchedule(data, offerId, runAt, { now, persist, rpc: mock.rpc }), { statusCode: 400 });
  assert.equal(mock.state.requests.length, 0);
  await create(data, mock);
  assert.equal(data.xiaochanSchedules![offerId]!.advanceOrder, true);
  assert.equal(data.xiaochanSchedules![offerId]!.runAt, time("09:30:00").toISOString());
  assert.equal(JSON.stringify(publicSession(data)).includes("advanceOrder"), false);
});

test("Unsupported or mismatched official activity details fail closed before reservation", async () => {
  for (const detail of [{ if_seckill: true }, { is_major: true }, { is_brand_promotion: true }, { big_brand_type: 4 },
    { promotion_id: 43 }, { meituan_status: 2 }, { start_time_hour: null }, { start_time_hour: 11 }]) {
    const data = session(), mock = upstream(); mock.state.detail = detail;
    await assert.rejects(create(data, mock));
    assert.equal(data.xiaochanSchedules?.[offerId], undefined);
    assert.equal(grabs(mock).length, 0);
  }
  const data = session(), mock = upstream(); data.offers.xiaochan[0]!.advanceEnrollmentAvailable = false;
  assert.deepEqual((await getXiaochanScheduleOptions(data, offerId, { now, rpc: mock.rpc })).advanceWindows, []);
  await assert.rejects(create(data, mock));
  assert.equal(mock.state.requests.length, 0);
});

test("Scheduled early execution rechecks the account and sends the automatic coupon flag only after durable pending state", async () => {
  const data = session(), mock = upstream();
  await create(data, mock);
  const original = structuredClone(data.offers);
  let saves = 0;
  const rpc = (async request => {
    if (request.methodName.endsWith("GrabPromotionQuota")) {
      assert.ok(saves >= 2);
      assert.equal(data.xiaochanEnrollments![offerId]!.state, "unknown");
      assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, true);
      assert.equal(request.body.if_advance_order, true);
      assert.equal(request.body.if_pre_order, false);
      assert.equal("card_id" in request.body, false);
    }
    return mock.rpc(request);
  }) as typeof xiaochanRpc;
  await runXiaochanSchedule(data, offerId, { now: time("09:30:00"), persist: async () => { saves++; }, rpc });
  assert.equal(data.xiaochanEnrollments![offerId]!.state, "enrolled");
  assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, true);
  assert.equal(data.xiaochanSchedules![offerId], undefined);
  assert.deepEqual(data.offers, original);
  assert.equal(mock.state.requests.filter(row => row.methodName.endsWith("GetUserCardList")).length, 2);
  assert.equal(grabs(mock).length, 1);
});

test("A coupon consumed on the phone or expired before execution never submits a quota request", async () => {
  for (const cards of [[], [{ ...card(), status: 1 }], [card(1, "09:30:00")]]) {
    const data = session(), mock = upstream(); await create(data, mock); mock.state.cards = cards;
    await runXiaochanSchedule(data, offerId, { now: time("09:30:00"), persist, rpc: mock.rpc });
    assert.equal(data.xiaochanSchedules![offerId]!.state, "failed");
    assert.match(data.xiaochanSchedules![offerId]!.message!, /超前抢单券不足/);
    assert.equal(data.xiaochanEnrollments?.[offerId], undefined);
    assert.equal(grabs(mock).length, 0);
  }
});

test("An ordinary-time execution of an early reservation does not query or use a coupon", async () => {
  const data = session(), mock = upstream(); await create(data, mock, "09:59:59");
  mock.state.cards = []; mock.state.requests = [];
  await runXiaochanSchedule(data, offerId, { now: time("10:00:00"), persist, rpc: mock.rpc });
  assert.equal(mock.state.requests.length, 1);
  assert.equal(grabs(mock)[0]!.body.if_advance_order, false);
  assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, undefined);
});

test("Unknown early requests are not replayed and official confirmation preserves the early marker", async () => {
  const data = session(), mock = upstream(); await create(data, mock); mock.state.failGrab = true;
  const options = { now: time("09:30:00"), persist, rpc: mock.rpc };
  await runXiaochanSchedule(data, offerId, options);
  await runXiaochanSchedule(data, offerId, options);
  assert.equal(grabs(mock).length, 1);
  assert.equal(data.xiaochanEnrollments![offerId]!.state, "unknown");
  assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, true);
  data.offers.xiaochan.push({ ...data.offers.xiaochan[0]!, id: "xiaochan:43" });
  await assert.rejects(create(data, mock, "09:31:00", "xiaochan:43"), /超前抢单待确认/);
  await enrollXiaochan(data, offerId, { ...options, rpc: (async request => {
    assert.equal(request.methodName, "SilkwormService.GetStorePromotionDetail");
    return { status: { code: 0 }, promotion_detail: { promotion_id: 42, meituan_status: 1 },
      order_list: [{ store_platform: 1, promotion_order_id: 9042, order_status: 0 }] };
  }) as typeof xiaochanRpc });
  assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, true);
  assert.equal(data.xiaochanEnrollments![offerId]!.state, "enrolled");
});

test("One coupon cannot back two scheduled activities; cancelling the task releases capacity", async () => {
  const data = session(), mock = upstream();
  data.offers.xiaochan.push({ ...data.offers.xiaochan[0]!, id: "xiaochan:43" });
  await create(data, mock);
  await assert.rejects(create(data, mock, "09:31:00", "xiaochan:43"), /超前抢单券不足/);
  assert.deepEqual((await getXiaochanScheduleOptions(data, "xiaochan:43", { now, rpc: mock.rpc })).advanceWindows, []);
  cancelXiaochanSchedule(data, offerId);
  await create(data, mock, "09:31:00", "xiaochan:43");
  assert.equal(data.xiaochanSchedules!["xiaochan:43"]!.advanceOrder, true);
});

test("Concurrent browser sessions serialize capacity reservation for the same Xiaochan account", async () => {
  const first = session(), second = structuredClone(first), mock = upstream();
  const ids = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  await saveSession(ids[0]!, first); await saveSession(ids[1]!, second);
  const results = await Promise.allSettled([first, second].map((data, index) => createXiaochanSchedule(data, offerId,
    time("09:30:00").toISOString(), { now, rpc: mock.rpc, persist: () => saveSession(ids[index]!, data) })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.statusMessage, "超前抢单券不足");
});

test("Failed schedule persistence rolls back both new and replacement coupon reservations", async () => {
  for (const existing of [false, true]) {
    const data = session(), mock = upstream();
    if (existing) await create(data, mock, "09:40:00");
    const previous = structuredClone(data.xiaochanSchedules?.[offerId]);
    await assert.rejects(createXiaochanSchedule(data, offerId, time("09:30:00").toISOString(), {
      now, rpc: mock.rpc, persist: async () => { throw new Error("Storage failed"); },
    }), /Storage failed/);
    assert.deepEqual(data.xiaochanSchedules?.[offerId], previous);
    assert.equal(grabs(mock).length, 0);
  }
});

test("Failing to persist the early pending attempt prevents the quota call", async () => {
  const data = session(), mock = upstream(); await create(data, mock);
  let saves = 0;
  await runXiaochanSchedule(data, offerId, { now: time("09:30:00"), rpc: mock.rpc,
    persist: async () => { if (++saves === 2) throw new Error("Storage failed"); },
  });
  assert.equal(grabs(mock).length, 0);
  assert.equal(data.xiaochanEnrollments?.[offerId], undefined);
  assert.equal(data.xiaochanSchedules![offerId]!.state, "failed");
});

test("Late, changed-account, changed-address and now-ineligible early schedules do not submit", async () => {
  for (const mode of ["late", "account", "address", "detail"]) {
    const data = session(), mock = upstream(); await create(data, mock);
    if (mode === "account") data.xiaochanAccount!.userId = "9999";
    if (mode === "address") data.location!.latitude = 32;
    if (mode === "detail") mock.state.detail.if_seckill = true;
    await runXiaochanSchedule(data, offerId, { now: time(mode === "late" ? "09:31:01" : "09:30:00"), persist, rpc: mock.rpc });
    assert.equal(grabs(mock).length, 0);
    assert.equal(data.xiaochanSchedules![offerId]!.state, "failed");
  }
});

test("A selected activity omitted by a subsequent feed is still executed and exposed for confirmation", async () => {
  const data = session(), mock = upstream(); await create(data, mock); data.offers.xiaochan = [];
  await runXiaochanSchedule(data, offerId, { now: time("09:30:00"), persist, rpc: mock.rpc });
  assert.equal(grabs(mock).length, 1);
  assert.equal(publicSession(data).offers.xiaochan[0]!.enrollment!.state, "enrolled");
  assert.equal(data.offers.xiaochan[0]!.startTime, "10:00");
});

test("Coupon expiry during a slow execution-time lookup is rechecked against the current clock", async t => {
  const data = session(), mock = upstream(); mock.state.cards = [card(1, "09:45:00")];
  await create(data, mock, "09:44:59");
  t.mock.timers.enable({ apis: ["Date"], now: time("09:44:59").getTime() });
  await runXiaochanSchedule(data, offerId, { persist, rpc: (async request => {
    const result = await mock.rpc(request);
    if (request.methodName.endsWith("GetUserCardList")) t.mock.timers.tick(1001);
    return result;
  }) as typeof xiaochanRpc });
  assert.equal(grabs(mock).length, 0);
  assert.equal(data.xiaochanSchedules![offerId]!.state, "failed");
});

test("Pending persistence crossing the opening switches to ordinary submission and persists that flag", async t => {
  const data = session(), mock = upstream(); await create(data, mock, "09:59:59");
  t.mock.timers.enable({ apis: ["Date"], now: time("09:59:59").getTime() });
  let saves = 0;
  await runXiaochanSchedule(data, offerId, { rpc: mock.rpc, persist: async () => {
    if (++saves === 2) t.mock.timers.tick(1001);
    if (saves === 3) assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, undefined);
  } });
  assert.equal(grabs(mock).length, 1);
  assert.equal(grabs(mock)[0]!.body.if_advance_order, false);
  assert.equal(data.xiaochanEnrollments![offerId]!.advanceOrder, undefined);
});

test("Pending persistence crossing coupon expiry or the execution grace period never submits", async t => {
  for (const mode of ["expiry", "late"]) {
    const data = session(), mock = upstream(); mock.state.cards = [card(1, mode === "expiry" ? "09:45:00" : "11:00:00")];
    await create(data, mock, "09:44:59");
    t.mock.timers.enable({ apis: ["Date"], now: time("09:44:59").getTime() });
    let saves = 0;
    await runXiaochanSchedule(data, offerId, { rpc: mock.rpc, persist: async () => {
      if (++saves === 2) t.mock.timers.tick(mode === "expiry" ? 1001 : 60_001);
    } });
    assert.equal(grabs(mock).length, 0);
    assert.equal(data.xiaochanEnrollments?.[offerId], undefined);
    assert.equal(data.xiaochanSchedules![offerId]!.state, "failed");
    t.mock.timers.reset();
  }
});

test("Ordinary replacement rollback holds the coupon lock until the original reservation is restored", async () => {
  const first = session(), second = structuredClone(first), mock = upstream();
  const ids = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  await saveSession(ids[0]!, first); await saveSession(ids[1]!, second);
  await createXiaochanSchedule(first, offerId, time("09:30:00").toISOString(), {
    now, rpc: mock.rpc, persist: () => saveSession(ids[0]!, first),
  });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  const replacing = assert.rejects(createXiaochanSchedule(first, offerId, time("10:00:00").toISOString(), {
    now, rpc: mock.rpc, persist: async () => { started(); await gate; throw new Error("Storage failed"); },
  }), /Storage failed/);
  await writing;
  const creating = assert.rejects(createXiaochanSchedule(second, offerId, time("09:31:00").toISOString(), {
    now, rpc: mock.rpc, persist: () => saveSession(ids[1]!, second),
  }), /超前抢单券不足/);
  release(); await replacing; await creating;
  assert.equal(first.xiaochanSchedules![offerId]!.advanceOrder, true);
  assert.equal(second.xiaochanSchedules?.[offerId], undefined);
});

test("Verified detail times are never exposed or persisted as the source offer's pricing times", async () => {
  const data = session(), mock = upstream(); mock.state.detail.start_time_minute = 4;
  await create(data, mock, "09:35:00");
  assert.equal(data.xiaochanSchedules![offerId]!.offer.startTime, "10:04");
  const original = structuredClone(data.offers);
  await runXiaochanSchedule(data, offerId, { now: time("09:35:00"), rpc: mock.rpc, persist: async () => {
    assert.deepEqual(data.offers, original);
    assert.equal(publicSession(data).offers.xiaochan[0]!.startTime, "10:00");
  } });
  assert.equal(grabs(mock).length, 1);
  assert.deepEqual(data.offers, original);
});

after(async () => {
  if (previousDirectory === undefined) delete process.env.FOOD_DATA_DIR;
  else process.env.FOOD_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});
