import test from "node:test";
import assert from "node:assert/strict";
import type { Offer } from "../shared/types";
import { canScheduleEnrollment, defaultEnrollmentTime, todayEnrollmentWindow } from "../shared/utils/enrollment-time";

const now = new Date("2026-11-07T04:59:50Z");
const offer: Offer = {
  id: "waimai:shop-1:activity-2", provider: "waimai", name: "预约测试店", category: "美食",
  source: "live", enrollmentAvailable: true, collectedAt: now.toISOString(), inventory: 3, distanceMeters: 1000,
  startTime: "13:00", endTime: "14:00", requirement: "无需评价",
  rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
};

test("Waimai schedule defaults to today's exact opening time in Shanghai", () => {
  assert.equal(defaultEnrollmentTime(offer, now), "2026-11-07T13:00:00");
  assert.deepEqual(todayEnrollmentWindow(offer, now), {
    start: Date.parse("2026-11-07T05:00:00Z"), end: Date.parse("2026-11-07T06:00:00Z"),
  });
  assert.equal(canScheduleEnrollment(offer, new Date("2026-11-07T05:00:00Z"), now), true);
  assert.equal(canScheduleEnrollment(offer, new Date("2026-11-07T05:59:59Z"), now), true);
  for (const time of [now, new Date("2026-11-07T04:59:59Z"), new Date("2026-11-07T06:00:00Z"), new Date("2026-11-08T05:00:00Z")])
    assert.equal(canScheduleEnrollment(offer, time, now), false);
});

test("Waimai schedules exclude unavailable, imported and stale activities without enabling Meituan enrollment", () => {
  for (const change of [
    { source: "import" as const }, { provider: "meituan" as const }, { inventory: 0 },
    { enrollmentAvailable: false }, { enrollmentAvailable: undefined },
    { inventory: undefined }, { collectedAt: "2026-11-06T04:00:00Z" },
    { validFrom: "2026-11-08T00:00:00Z" }, { validUntil: "2026-11-07T04:00:00Z" },
  ]) {
    assert.equal(todayEnrollmentWindow({ ...offer, ...change }, now), undefined);
    assert.equal(defaultEnrollmentTime({ ...offer, ...change }, now), "");
  }
  assert.deepEqual(todayEnrollmentWindow({ ...offer, provider: "xiaochan", id: "xiaochan:2" }, now),
    todayEnrollmentWindow(offer, now));
});

test("Waimai schedule validity and midnight boundaries retain the shared scheduling contract", () => {
  const limited = { ...offer, validUntil: "2026-11-07T05:30:00Z" };
  assert.equal(canScheduleEnrollment(limited, new Date("2026-11-07T05:29:59Z"), now), true);
  assert.equal(canScheduleEnrollment(limited, new Date(limited.validUntil), now), false);
  const late = new Date("2026-11-07T15:59:50Z");
  const allDay = { ...offer, startTime: "00:00", endTime: "24:00" };
  assert.equal(defaultEnrollmentTime(allDay, late), "2026-11-07T23:59:59");
  assert.equal(canScheduleEnrollment(allDay, new Date("2026-11-07T16:00:00Z"), late), false);
});
