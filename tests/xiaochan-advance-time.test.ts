import test from "node:test";
import assert from "node:assert/strict";
import type { EnrollmentTimeWindow, Offer } from "../shared/types";
import { defaultEnrollmentTime, todayEnrollmentWindow } from "../shared/utils/enrollment-time";
import { defaultScheduleTime, scheduleTimeWindows, xiaochanAdvanceWindow } from "../shared/utils/xiaochan-advance-time";

const time = (clock: string, day = "2026-11-07") => Date.parse(`${day}T${clock}+08:00`);
const now = new Date(time("09:00:00"));
const offer: Offer = {
  id: "xiaochan:42", provider: "xiaochan", name: "测试店", category: "美食",
  source: "live", collectedAt: now.toISOString(), inventory: 3,
  startTime: "10:00", endTime: "11:00", validFrom: new Date(time("10:00:00")).toISOString(),
  validUntil: new Date(time("11:00:00")).toISOString(), advanceEnrollmentAvailable: true,
  requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
};
const advance = { start: time("09:30:00"), end: time("10:00:00") };
const ordinary = { start: time("10:00:00"), end: time("11:00:00") };
const contains = (windows: EnrollmentTimeWindow[], at: number) => windows.some(window => at >= window.start && at < window.end);

test("Xiaochan advance availability opens exactly 30 minutes before the original opening", () => {
  const before = structuredClone(offer);
  assert.deepEqual(xiaochanAdvanceWindow(offer, now), advance);
  assert.deepEqual(todayEnrollmentWindow(offer, now), ordinary);
  assert.deepEqual(scheduleTimeWindows(offer, now), [ordinary]);
  const windows = scheduleTimeWindows(offer, now, [advance]);
  assert.deepEqual(windows, [{ start: advance.start, end: ordinary.end }]);
  assert.equal(contains(windows, advance.start), true);
  assert.equal(contains(windows, advance.start - 1), false);
  assert.equal(contains(windows, ordinary.end), false);
  assert.equal(defaultScheduleTime(offer, now, [advance]), "2026-11-07T09:30:00");
  assert.equal(defaultScheduleTime(offer, now), "2026-11-07T10:00:00");
  assert.deepEqual(offer, before);
});

test("A coupon expiring before opening leaves an unselectable gap", () => {
  const earlyExpiry = { start: advance.start, end: time("09:45:00") };
  const windows = scheduleTimeWindows(offer, now, [earlyExpiry]);
  assert.deepEqual(windows, [earlyExpiry, ordinary]);
  assert.equal(contains(windows, time("09:44:59.999")), true);
  assert.equal(contains(windows, time("09:45:00")), false);
  assert.equal(contains(windows, time("09:59:59.999")), false);
  assert.equal(contains(windows, ordinary.start), true);
  assert.equal(defaultScheduleTime(offer, new Date(time("09:45:00")), [earlyExpiry]), "2026-11-07T10:00:00");
});

test("Advance windows use the original opening instead of subtracting from the current clamped time", () => {
  const later = new Date(time("09:40:00"));
  assert.deepEqual(xiaochanAdvanceWindow(offer, later), { start: later.getTime() + 1, end: advance.end });
  assert.equal(defaultScheduleTime(offer, later, [advance]), "2026-11-07T09:40:01");
  assert.equal(contains(scheduleTimeWindows(offer, later, [advance]), later.getTime()), false);
  assert.equal(xiaochanAdvanceWindow(offer, new Date(advance.end)), undefined);
  assert.equal(xiaochanAdvanceWindow(offer, new Date(advance.end + 1)), undefined);
});

test("Window merging clamps to the potential advance range and retains real gaps", () => {
  const supplied = [
    { start: time("09:38:00"), end: time("09:45:00") },
    { start: time("09:20:00"), end: time("09:40:00") },
    { start: time("09:50:00"), end: time("10:20:00") },
    { start: NaN, end: ordinary.end }, { start: 0, end: 0 }, null,
    { start: time("09:30:00", "2026-11-06"), end: time("09:45:00", "2026-11-06") },
  ] as EnrollmentTimeWindow[];
  assert.deepEqual(scheduleTimeWindows(offer, now, supplied), [
    { start: advance.start, end: time("09:45:00") },
    { start: time("09:50:00"), end: ordinary.end },
  ]);
  assert.deepEqual(supplied[0], { start: time("09:38:00"), end: time("09:45:00") });
});

test("Advance availability requires today's valid live Xiaochan activity and explicit unsupported flags remain disabled", () => {
  for (const change of [
    { provider: "waimai" as const }, { provider: "meituan" as const }, { source: "import" as const },
    { inventory: 0 }, { inventory: undefined }, { inventory: 1.5 }, { advanceEnrollmentAvailable: false },
    { startTime: undefined }, { startTime: "invalid" }, { startTime: "24:00" }, { endTime: "25:00" },
    { collectedAt: "invalid" }, { validFrom: "invalid" }, { validUntil: "invalid" },
    { validFrom: new Date(time("10:00:00", "2026-11-06")).toISOString() },
    { validFrom: new Date(time("10:00:00", "2026-11-08")).toISOString() },
    { validFrom: new Date(ordinary.start + 1).toISOString() },
    { validUntil: new Date(ordinary.start).toISOString() },
    { validUntil: new Date(ordinary.start - 1).toISOString() },
  ]) assert.equal(xiaochanAdvanceWindow({ ...offer, ...change }, now), undefined, JSON.stringify(change));
  assert.deepEqual(xiaochanAdvanceWindow({ ...offer, advanceEnrollmentAvailable: undefined }, now), advance);
  assert.equal(xiaochanAdvanceWindow(offer, new Date(NaN)), undefined);
  assert.deepEqual(scheduleTimeWindows(offer, new Date(NaN), [advance]), []);
});

test("Stale collection needs today's explicit validity and advance time never crosses midnight", () => {
  const old = { ...offer, collectedAt: new Date(time("09:00:00", "2026-11-06")).toISOString() };
  assert.deepEqual(xiaochanAdvanceWindow(old, now), advance);
  assert.equal(xiaochanAdvanceWindow({ ...old, validFrom: undefined }, now), undefined);
  const midnight = new Date(time("00:00:00"));
  const early = { ...offer, startTime: "00:10", endTime: "01:00", collectedAt: midnight.toISOString(),
    validFrom: new Date(time("00:10:00")).toISOString(), validUntil: new Date(time("01:00:00")).toISOString() };
  assert.deepEqual(xiaochanAdvanceWindow(early, midnight), { start: midnight.getTime() + 1, end: time("00:10:00") });
  assert.equal(xiaochanAdvanceWindow(early, new Date(time("23:55:00", "2026-11-06"))), undefined);
  assert.equal(xiaochanAdvanceWindow({ ...early, startTime: "00:00" }, midnight), undefined);
});

test("Ordinary defaults and Waimai windows remain unchanged and never consume advance ranges", () => {
  const activeNow = new Date(time("10:15:20"));
  assert.equal(defaultScheduleTime(offer, activeNow, [advance]), defaultEnrollmentTime(offer, activeNow));
  assert.equal(defaultScheduleTime(offer, activeNow, [advance]), "2026-11-07T10:16:20");
  const waimai: Offer = { ...offer, provider: "waimai", id: "waimai:shop:sku", enrollmentAvailable: true };
  assert.deepEqual(scheduleTimeWindows(waimai, now, [advance]), [ordinary]);
  assert.equal(defaultScheduleTime(waimai, now, [advance]), defaultEnrollmentTime(waimai, now));
  assert.deepEqual(scheduleTimeWindows({ ...waimai, enrollmentAvailable: false }, now, [advance]), []);
  const allDay = { ...offer, startTime: "00:00", endTime: "24:00", validFrom: undefined, validUntil: undefined };
  assert.equal(defaultScheduleTime(allDay, now, [advance]), "2026-11-07T09:01:00");
  assert.equal(defaultScheduleTime(allDay, new Date(time("23:59:50")), [advance]), "2026-11-07T23:59:59");
});
