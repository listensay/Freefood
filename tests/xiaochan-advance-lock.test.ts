import "./fixtures/session-key";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { LocalSession } from "../server/utils/session";

const directory = await mkdtemp(join(tmpdir(), "food-xiaochan-advance-lock-"));
const previousDirectory = process.env.FOOD_DATA_DIR;
process.env.FOOD_DATA_DIR = directory;
const { emptySession, saveSession } = await import("../server/utils/session");
const { assertAdvanceCouponCapacity, withXiaochanAdvanceLock, xiaochanAdvanceReservations } =
  await import("../server/utils/xiaochan-advance-lock");

const deadline = "2026-11-07T04:30:00Z";
const time = Date.parse(deadline);
const accountId = (data: LocalSession) => `${data.xiaochanAccount!.silkId}:${data.xiaochanAccount!.userId}`;
function session(silkId: string, userId = "6789"): LocalSession {
  const data = emptySession();
  data.xiaochanAccount = { silkId, userId, accessToken: "private-token" };
  data.connections.xiaochan = { state: "connected", label: "已登录" };
  data.location = { label: "测试地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 };
  return data;
}
function schedule(data: LocalSession, offerId: string, state: "scheduled" | "running" | "failed" = "scheduled", advanceOrder = true) {
  (data.xiaochanSchedules ||= {})[offerId] = {
    offerId, name: "测试店", runAt: deadline, state, advanceOrder,
    accountId: accountId(data), location: data.location!,
    offer: { id: offerId, provider: "xiaochan", name: "测试店", category: "美食", source: "live",
      collectedAt: deadline, requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 } },
  };
}
const persist = (data: LocalSession) => saveSession(randomBytes(32).toString("hex"), data);

test("Advance reservations include same-account sessions and an unsaved current session without double counting", async () => {
  const current = session("1001"), other = session("1001"), unrelated = session("1002");
  schedule(current, "xiaochan:1");
  schedule(other, "xiaochan:2", "running");
  schedule(other, "xiaochan:3", "failed");
  schedule(other, "xiaochan:4", "scheduled", false);
  schedule(unrelated, "xiaochan:5");
  await persist(other);
  await persist(unrelated);
  const expected = [{ offerId: "xiaochan:1", runAt: deadline }, { offerId: "xiaochan:2", runAt: deadline }];
  assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current), expected);
  await persist(current);
  assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current), expected);
  const differentUser = session("1001", "6790");
  schedule(differentUser, "xiaochan:6");
  await persist(differentUser);
  assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current), expected);
});

test("Excluding a task only excludes the current session, not another session's identical offer", async () => {
  const current = session("2001"), other = session("2001");
  schedule(current, "xiaochan:1");
  schedule(current, "xiaochan:2");
  schedule(other, "xiaochan:1");
  await persist(current);
  await persist(other);
  assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current, "xiaochan:1"), [
    { offerId: "xiaochan:2", runAt: deadline }, { offerId: "xiaochan:1", runAt: deadline },
  ]);
});

test("Unknown advance mutations block the entire account while ordinary and confirmed enrollments do not", async () => {
  for (const state of ["unknown", "cancel-unknown"] as const) {
    const current = session(state === "unknown" ? "3001" : "3002"), other = session(current.xiaochanAccount!.silkId);
    other.xiaochanEnrollments = { "xiaochan:1": { state, advanceOrder: true, updatedAt: deadline } };
    await persist(other);
    await assert.rejects(xiaochanAdvanceReservations(accountId(current), current, "xiaochan:1"),
      { statusCode: 409, statusMessage: "超前抢单待确认" });
    other.xiaochanEnrollments["xiaochan:1"]!.advanceOrder = false;
    assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current), []);
    other.xiaochanEnrollments["xiaochan:1"] = { state: "enrolled", advanceOrder: true, orderId: "9001", updatedAt: deadline };
    assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current), []);
  }
});

test("An excluded current unknown attempt does not suppress another pending attempt or another account", async () => {
  const current = session("4001"), other = session("4002");
  current.xiaochanEnrollments = { "xiaochan:1": { state: "unknown", advanceOrder: true, updatedAt: deadline } };
  other.xiaochanEnrollments = { "xiaochan:1": { state: "unknown", advanceOrder: true, updatedAt: deadline } };
  await persist(current);
  await persist(other);
  assert.deepEqual(await xiaochanAdvanceReservations(accountId(current), current, "xiaochan:1"), []);
  current.xiaochanEnrollments["xiaochan:2"] = { state: "cancel-unknown", advanceOrder: true, updatedAt: deadline };
  await assert.rejects(xiaochanAdvanceReservations(accountId(current), current, "xiaochan:1"),
    { statusCode: 409, statusMessage: "超前抢单待确认" });
});

test("Capacity assigns earliest-expiring eligible coupons to chronologically ordered reservations without mutation", () => {
  const coupons = [
    { id: "late", startsAt: time, expiresAt: time + 10_000 },
    { id: "early", startsAt: time, expiresAt: time + 1000 },
    { id: "future", startsAt: time + 20_000, expiresAt: time + 30_000 },
  ];
  const reservations = [
    { offerId: "xiaochan:2", runAt: new Date(time + 5000).toISOString() },
    { offerId: "xiaochan:3", runAt: new Date(time + 20_000).toISOString() },
    { offerId: "xiaochan:1", runAt: deadline },
  ];
  const before = structuredClone({ coupons, reservations });
  assert.equal(assertAdvanceCouponCapacity(coupons, reservations), undefined);
  assert.deepEqual({ coupons, reservations }, before);
});

test("Capacity includes coupon activation, excludes expiration and never counts duplicate coupon IDs twice", () => {
  const coupon = { id: "one", startsAt: time, expiresAt: time + 1000 };
  const at = (offset: number) => [{ offerId: "xiaochan:1", runAt: new Date(time + offset).toISOString() }];
  assert.doesNotThrow(() => assertAdvanceCouponCapacity([coupon], at(0)));
  assert.doesNotThrow(() => assertAdvanceCouponCapacity([coupon], at(999)));
  for (const offset of [-1, 1000]) assert.throws(() => assertAdvanceCouponCapacity([coupon], at(offset)),
    { statusCode: 409, statusMessage: "超前抢单券不足" });
  assert.throws(() => assertAdvanceCouponCapacity([coupon, { ...coupon }], [...at(0), ...at(1)]),
    { statusCode: 409, statusMessage: "超前抢单券不足" });
  assert.throws(() => assertAdvanceCouponCapacity([], at(0)), { statusCode: 409 });
  assert.throws(() => assertAdvanceCouponCapacity([coupon], [{ offerId: "xiaochan:1", runAt: "invalid" }]), { statusCode: 409 });
  for (const invalid of [{ ...coupon, startsAt: NaN }, { ...coupon, expiresAt: Infinity }, { ...coupon, id: "" }])
    assert.throws(() => assertAdvanceCouponCapacity([invalid], at(0)), { statusCode: 409 });
  assert.doesNotThrow(() => assertAdvanceCouponCapacity([], []));
});

test("Advance locks serialize the same account, allow other accounts and recover after rejection", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withXiaochanAdvanceLock("lock-account", async () => {
    events.push("first-start");
    await gate;
    events.push("first-end");
    throw new Error("first failed");
  });
  const rejected = assert.rejects(first, /first failed/);
  const second = withXiaochanAdvanceLock("lock-account", async () => { events.push("second"); return 2; });
  const parallel = withXiaochanAdvanceLock("other-account", async () => { events.push("parallel"); return 3; });
  await setImmediate();
  assert.deepEqual(events, ["first-start", "parallel"]);
  assert.equal(await parallel, 3);
  release();
  await rejected;
  assert.equal(await second, 2);
  assert.deepEqual(events, ["first-start", "parallel", "first-end", "second"]);
  assert.equal(await withXiaochanAdvanceLock("lock-account", async () => 4), 4);
});

after(async () => {
  if (previousDirectory === undefined) delete process.env.FOOD_DATA_DIR;
  else process.env.FOOD_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});
