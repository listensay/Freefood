import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSession } from "../server/utils/session";
import { createWaimaiTransport } from "./fixtures/waimai-enrollment";

const directory = await mkdtemp(join(tmpdir(), "food-waimai-schedules-"));
const previousDirectory = process.env.FOOD_DATA_DIR;
process.env.FOOD_DATA_DIR = directory;
const { emptySession, loadSession, publicSession, saveSession } = await import("../server/utils/session");
const {
  armWaimaiSchedules, cancelWaimaiSchedule, closeWaimaiSchedules,
  restoreWaimaiSchedules, runWaimaiSchedule, setWaimaiSchedule,
} = await import("../server/utils/waimai-schedules");

const now = new Date("2026-11-07T04:00:00Z");
const offerId = "waimai:shop-42:sku-43";
function session(at = now): LocalSession {
  const data = emptySession();
  data.waimaiAccount = { uid: "123456789", userId: "example-user", token: "private-token" };
  data.connections.waimai = { state: "connected", label: "已登录" };
  data.location = { label: "测试地址", cityCode: 310100, cityName: "上海市", latitude: 31.23, longitude: 121.47 };
  data.offers.waimai = [{
    id: offerId, provider: "waimai", name: "测试店", category: "美食",
    inventory: 3, distanceMeters: 1000, startTime: "00:00", endTime: "24:00",
    requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
    source: "live", collectedAt: at.toISOString(), enrollmentAvailable: true,
  }];
  return data;
}
const noTransport = (async () => assert.fail("Unexpected upstream request")) as typeof fetch;
const enrolledOrder = {
  buyOverbearfoodId: "order-42", businessId: "shop-42", overbearfoodId: "sku-43",
  platform: "meituan", type: "overbear_food", status: "buy_signup", serviceId: "service-42",
};

test("Waimai scheduling snapshots the chosen tier, account and address without exposing private state", () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  const schedule = setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  assert.equal(schedule.accountId, "123456789:example-user");
  assert.equal(schedule.offer.id, offerId);
  assert.equal(schedule.state, "scheduled");
  data.offers.waimai[0]!.name = "同步后的名称";
  data.location!.label = "修改后的地址";
  assert.equal(schedule.name, "测试店");
  assert.equal(schedule.offer.name, "测试店");
  assert.equal(schedule.location.label, "测试地址");
  const result = publicSession(data);
  assert.deepEqual(result.enrollmentSchedules, [{ offerId, name: "测试店", runAt: deadline.toISOString(), state: "scheduled" }]);
  assert.deepEqual(result.offers.waimai[0]!.enrollmentSchedule, result.enrollmentSchedules![0]);
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  assert.equal(JSON.stringify(result).includes("accountId"), false);
});

test("Public enrollment and schedules remain isolated between platforms and override stale offer payloads", () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  data.offers.xiaochan = [{ ...data.offers.waimai[0]!, id: "xiaochan:42", provider: "xiaochan" }];
  setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  data.xiaochanSchedules = { "xiaochan:42": {
    ...data.waimaiSchedules![offerId]!, offerId: "xiaochan:42", offer: data.offers.xiaochan[0]!, accountId: "private-xiaochan-account",
  } };
  data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "x-order", updatedAt: now.toISOString() } };
  data.waimaiEnrollments = { [offerId]: { state: "unknown", updatedAt: now.toISOString() } };
  data.offers.waimai[0]!.enrollment = { state: "enrolled", orderId: "stale-order" };
  let result = publicSession(data);
  assert.equal(result.enrollmentSchedules?.length, 2);
  assert.deepEqual(result.offers.xiaochan[0]!.enrollment, { state: "enrolled", orderId: "x-order" });
  assert.deepEqual(result.offers.waimai[0]!.enrollment, { state: "unknown", orderId: undefined });
  assert.equal(JSON.stringify(result).includes("private-xiaochan-account"), false);
  delete data.waimaiEnrollments;
  delete data.waimaiSchedules;
  result = publicSession(data);
  assert.equal(result.offers.waimai[0]!.enrollment, undefined);
  assert.equal(result.offers.waimai[0]!.enrollmentSchedule, undefined);
  assert.equal(result.enrollmentSchedules?.length, 1);
});

test("Waimai schedules reject invalid identities, inactive tiers, stale dates and existing enrollments", () => {
  const deadline = new Date(now.getTime() + 1000).toISOString();
  for (const id of [undefined, {}, "xiaochan:42", "waimai:42", "waimai:shop:sku/other", `waimai:${"x".repeat(129)}:sku`, "waimai:shop-42:missing"])
    assert.throws(() => setWaimaiSchedule(session(), id, deadline, now));
  for (const time of [now.toISOString(), "invalid", "2026-11-08T04:00:00Z", "2026-11-07T12:00:01", "2026-11-07T12:00:01-04:00"])
    assert.throws(() => setWaimaiSchedule(session(), offerId, time, now));
  for (const mutate of [
    (data: LocalSession) => { delete data.waimaiAccount; },
    (data: LocalSession) => { data.waimaiAccount!.token = "bad\r\ntoken"; },
    (data: LocalSession) => { data.connections.waimai.state = "expired"; },
    (data: LocalSession) => { data.location = null; },
    (data: LocalSession) => { delete data.location!.cityName; },
    (data: LocalSession) => { data.offers.waimai[0]!.source = "import"; },
    (data: LocalSession) => { data.offers.waimai[0]!.provider = "meituan"; },
    (data: LocalSession) => { data.offers.waimai[0]!.enrollmentAvailable = false; },
    (data: LocalSession) => { delete data.offers.waimai[0]!.enrollmentAvailable; },
    (data: LocalSession) => { data.offers.waimai[0]!.inventory = 0; },
    (data: LocalSession) => { data.offers.waimai[0]!.distanceMeters = 7001; },
    (data: LocalSession) => { data.offers.waimai[0]!.collectedAt = "2026-11-06T04:00:00Z"; },
    (data: LocalSession) => { data.waimaiEnrollments = { [offerId]: { state: "unknown", updatedAt: now.toISOString() } }; },
  ]) {
    const data = session(); mutate(data);
    assert.throws(() => setWaimaiSchedule(data, offerId, deadline, now));
    assert.equal(data.waimaiSchedules, undefined);
  }
});

test("Waimai schedule cancellation only removes unexecuted jobs and rejects unrelated identifiers", () => {
  const data = session(), deadline = new Date(now.getTime() + 1000).toISOString();
  setWaimaiSchedule(data, offerId, deadline, now);
  assert.throws(() => cancelWaimaiSchedule(data, "xiaochan:42"));
  data.waimaiSchedules![offerId]!.state = "running";
  assert.throws(() => cancelWaimaiSchedule(data, offerId), /报名正在执行/);
  assert.throws(() => setWaimaiSchedule(data, offerId, deadline, now), /活动已有报名/);
  data.waimaiSchedules![offerId]!.state = "scheduled";
  cancelWaimaiSchedule(data, offerId);
  assert.equal(data.waimaiSchedules![offerId], undefined);
  data.waimaiEnrollments = { [offerId]: { state: "enrolled", orderId: "order-42", updatedAt: now.toISOString() } };
  assert.throws(() => cancelWaimaiSchedule(data, offerId), /报名已执行/);
});

test("Cancelled, early, late, account-changed and address-changed schedules do not reach the upstream", async () => {
  for (const mode of ["cancel", "early", "late", "uid", "userId", "address", "unsupported"]) {
    const data = session(), deadline = new Date(now.getTime() + 1000);
    setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
    if (mode === "cancel") cancelWaimaiSchedule(data, offerId);
    if (mode === "uid") data.waimaiAccount!.uid = "another-uid";
    if (mode === "userId") data.waimaiAccount!.userId = "another-user";
    if (mode === "address") data.location!.label = "其他地址";
    if (mode === "unsupported") delete data.waimaiSchedules![offerId]!.offer.enrollmentAvailable;
    await runWaimaiSchedule(data, offerId, {
      now: mode === "early" ? now : new Date(deadline.getTime() + (mode === "late" ? 60_001 : 0)),
      persist: async () => {}, transport: noTransport,
    });
    assert.equal(data.waimaiSchedules?.[offerId]?.state, mode === "cancel" ? undefined : mode === "early" ? "scheduled" : "failed");
  }
});

test("Schedule persistence failure prevents enrollment and preserves the unexecuted state", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  await assert.rejects(runWaimaiSchedule(data, offerId, {
    now: deadline, persist: async () => { throw new Error("Storage failed"); }, transport: noTransport,
  }), /Storage failed/);
  assert.equal(data.waimaiSchedules![offerId]!.state, "scheduled");
  assert.equal(data.waimaiEnrollments, undefined);
});

test("Already confirmed enrollment removes a due schedule without repeating its signup", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  data.waimaiEnrollments = { [offerId]: { state: "enrolled", orderId: "order-42", updatedAt: now.toISOString() } };
  await runWaimaiSchedule(data, offerId, { now: deadline, persist: async () => {}, transport: noTransport });
  assert.equal(data.waimaiSchedules![offerId], undefined);
  assert.equal(data.waimaiEnrollments[offerId]!.orderId, "order-42");
});

test("A schedule admits exactly 60 seconds of lateness and never runs a completed or failed task", async () => {
  for (const delay of [60_000, 60_001]) {
    const data = session(), deadline = new Date(now.getTime() + 1000);
    setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
    data.waimaiEnrollments = { [offerId]: { state: "enrolled", orderId: "order-42", updatedAt: now.toISOString() } };
    await runWaimaiSchedule(data, offerId, { now: new Date(deadline.getTime() + delay), persist: async () => {}, transport: noTransport });
    assert.equal(data.waimaiSchedules![offerId]?.state, delay === 60_000 ? undefined : "failed");
  }
  for (const state of ["running", "failed"] as const) {
    const data = session(), deadline = new Date(now.getTime() + 1000);
    setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
    data.waimaiSchedules![offerId]!.state = state;
    await runWaimaiSchedule(data, offerId, {
      now: deadline, persist: async () => assert.fail("Unexpected state replay"), transport: noTransport,
    });
    assert.equal(data.waimaiSchedules![offerId]!.state, state);
  }
});

test("A schedule encountering an uncertain manual signup only queries and does not submit again", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  data.waimaiEnrollments = { [offerId]: { state: "unknown", updatedAt: now.toISOString() } };
  let queries = 0;
  const transport = (async (url: string) => {
    assert.ok(url.endsWith("/api_overbear_orders_list"));
    queries++;
    return Response.json({ code: 1, data: [], count: 0 });
  }) as typeof fetch;
  const options = { now: deadline, persist: async () => {}, transport };
  await runWaimaiSchedule(data, offerId, options);
  await runWaimaiSchedule(data, offerId, options);
  assert.equal(queries, 1);
  assert.equal(data.waimaiSchedules![offerId]!.state, "failed");
  assert.equal(data.waimaiEnrollments[offerId]!.state, "unknown");
});

test("A due schedule submits its saved tier once and confirms the official order", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  let signed = false, persisted = 0;
  const { transport, calls } = createWaimaiTransport(request => {
    if (request.operation === "list") return { code: 1, count: signed ? 1 : 0, data: signed ? [enrolledOrder] : [] };
    assert.equal(request.operation, "signup");
    assert.equal(request.body.businessId, "shop-42");
    assert.equal(request.body.overbearfoodId, "sku-43");
    assert.ok(persisted >= 2);
    assert.equal(data.waimaiSchedules![offerId]!.state, "running");
    assert.equal(data.waimaiEnrollments![offerId]!.state, "unknown");
    signed = true;
    return { code: 200, data: { buyOverbearId: "order-42" } };
  }, { account: data.waimaiAccount!, city: data.location!.cityName! });
  const options = { transport, persist: async () => { persisted++; } };
  await runWaimaiSchedule(data, offerId, { ...options, now });
  assert.equal(calls.length, 0);
  data.offers.waimai = [];
  await runWaimaiSchedule(data, offerId, { ...options, now: deadline });
  await runWaimaiSchedule(data, offerId, { ...options, now: deadline });
  assert.equal(calls.filter(request => request.operation === "signup").length, 1);
  assert.equal(data.waimaiSchedules![offerId], undefined);
  assert.equal(data.waimaiEnrollments![offerId]!.state, "enrolled");
  assert.equal(data.waimaiEnrollments![offerId]!.orderId, "order-42");
  assert.equal(data.offers.waimai[0]!.id, offerId);
});

test("A lost scheduled signup response keeps the unknown attempt and never replays it", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
  const { transport, calls } = createWaimaiTransport(request => {
    if (request.operation === "list") return { code: 1, count: 0, data: [] };
    assert.equal(request.operation, "signup");
    throw new Error("Lost signup response");
  }, { account: data.waimaiAccount!, city: data.location!.cityName! });
  const options = { now: deadline, transport, persist: async () => {} };
  await runWaimaiSchedule(data, offerId, options);
  await runWaimaiSchedule(data, offerId, options);
  assert.equal(calls.filter(request => request.operation === "signup").length, 1);
  assert.equal(data.waimaiSchedules![offerId]!.state, "failed");
  assert.equal(data.waimaiSchedules![offerId]!.message, "报名待确认");
  assert.equal(data.waimaiEnrollments![offerId]!.state, "unknown");
  assert.throws(() => setWaimaiSchedule(data, offerId, new Date(deadline.getTime() + 1000).toISOString(), deadline));
});

test("Persistence failures before and after signup never replay a scheduled request", async () => {
  for (const failAt of [2, 3, 4, 5]) {
    const data = session(), deadline = new Date(now.getTime() + 1000);
    setWaimaiSchedule(data, offerId, deadline.toISOString(), now);
    let signed = false, persisted = 0;
    const saved: LocalSession[] = [];
    const { transport, calls } = createWaimaiTransport(request => {
      if (request.operation === "list") return { code: 1, count: signed ? 1 : 0, data: signed ? [enrolledOrder] : [] };
      assert.equal(request.operation, "signup");
      signed = true;
      return { code: 200, data: { buyOverbearId: "order-42" } };
    }, { account: data.waimaiAccount!, city: data.location!.cityName! });
    const options = { now: deadline, transport, persist: async () => {
      if (++persisted === failAt) throw new Error("Storage failed");
      saved.push(structuredClone(data));
    } };
    if (failAt === 5) await assert.rejects(runWaimaiSchedule(data, offerId, options), /Storage failed/);
    else await runWaimaiSchedule(data, offerId, options);
    await runWaimaiSchedule(data, offerId, options);
    assert.equal(calls.filter(request => request.operation === "signup").length, failAt === 2 ? 0 : 1);
    assert.notEqual(data.waimaiSchedules![offerId]?.state, "scheduled");
    assert.notEqual(saved.at(-1)!.waimaiSchedules![offerId]?.state, "scheduled");
    if (failAt === 5) {
      assert.equal(saved.at(-1)!.waimaiSchedules![offerId]!.state, "running");
      assert.equal(saved.at(-1)!.waimaiEnrollments![offerId]!.state, "enrolled");
    }
  }
});

test("Schedule arming is idempotent and cancellation releases the timer", t => {
  const at = new Date(), data = session(at);
  const deadline = new Date(at.getTime() + 1000);
  // A fixed future snapshot also avoids a boundary-sensitive wall-clock schedule validator.
  data.waimaiSchedules = { [offerId]: { offerId, name: "测试店", runAt: deadline.toISOString(), state: "scheduled",
    offer: data.offers.waimai[0]!, location: data.location!, accountId: "123456789:example-user" } };
  const set = t.mock.method(globalThis, "setTimeout");
  const clear = t.mock.method(globalThis, "clearTimeout");
  armWaimaiSchedules("timer-session", data);
  armWaimaiSchedules("timer-session", data);
  assert.equal(set.mock.callCount(), 1);
  cancelWaimaiSchedule(data, offerId);
  armWaimaiSchedules("timer-session", data);
  assert.equal(clear.mock.callCount(), 1);
  closeWaimaiSchedules();
});

test("Startup restores interrupted jobs as failed or completed without replaying enrollment", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", noTransport);
  for (const [index, state] of ["unknown", "enrolled", undefined].entries()) {
    const data = session(), id = String(index + 1).repeat(64);
    setWaimaiSchedule(data, offerId, new Date(now.getTime() + 1000).toISOString(), now);
    data.waimaiSchedules![offerId]!.state = "running";
    if (state) data.waimaiEnrollments = { [offerId]: { state: state as "unknown" | "enrolled", orderId: state === "enrolled" ? "order-42" : undefined, updatedAt: now.toISOString() } };
    await saveSession(id, data);
    await restoreWaimaiSchedules();
    const restored = await loadSession(id);
    if (state === "enrolled") assert.equal(restored.waimaiSchedules![offerId], undefined);
    else {
      assert.equal(restored.waimaiSchedules![offerId]!.state, "failed");
      assert.equal(restored.waimaiSchedules![offerId]!.message, state === "unknown" ? "报名待确认" : "预约报名已中断");
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

after(async () => {
  closeWaimaiSchedules();
  if (previousDirectory === undefined) delete process.env.FOOD_DATA_DIR;
  else process.env.FOOD_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});
