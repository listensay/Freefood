import type { EnrollmentTimeWindow, Offer } from "../types";
import { defaultEnrollmentTime, shanghaiDateTime, todayEnrollmentWindow } from "./enrollment-time";

const minuteOfDay = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return NaN;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour <= 24 && minute < 60 && (hour !== 24 || minute === 0) ? hour * 60 + minute : NaN;
};

export function xiaochanAdvanceWindow(offer: Offer, now = new Date()): EnrollmentTimeWindow | undefined {
  if (!Number.isFinite(now.getTime()) || offer.provider !== "xiaochan" || offer.source !== "live" ||
    offer.advanceEnrollmentAvailable === false || !Number.isSafeInteger(offer.inventory) || (offer.inventory ?? 0) <= 0 || !offer.startTime) return;
  const day = shanghaiDateTime(now).slice(0, 10);
  const collected = Date.parse(offer.collectedAt);
  const validFrom = offer.validFrom !== undefined ? Date.parse(offer.validFrom) : undefined;
  const validUntil = offer.validUntil !== undefined ? Date.parse(offer.validUntil) : undefined;
  const openingMinute = minuteOfDay(offer.startTime);
  if (!Number.isFinite(collected) || !Number.isFinite(openingMinute) || openingMinute >= 24 * 60 ||
    (offer.endTime !== undefined && !Number.isFinite(minuteOfDay(offer.endTime))) ||
    (validFrom !== undefined && !Number.isFinite(validFrom)) ||
    (validUntil !== undefined && !Number.isFinite(validUntil))) return;
  const midnight = Date.parse(`${day}T00:00:00+08:00`);
  const opening = midnight + openingMinute * 60_000;
  if ((validFrom !== undefined && (shanghaiDateTime(new Date(validFrom)).slice(0, 10) !== day || validFrom > opening)) ||
    (validUntil !== undefined && validUntil <= opening) || now.getTime() >= opening) return;
  if (shanghaiDateTime(new Date(collected)).slice(0, 10) !== day && validFrom === undefined) return;
  const start = Math.max(midnight, opening - 30 * 60_000, now.getTime() + 1);
  return start < opening ? { start, end: opening } : undefined;
}

export function scheduleTimeWindows(
  offer: Offer,
  now = new Date(),
  advanceWindows: EnrollmentTimeWindow[] = [],
): EnrollmentTimeWindow[] {
  if (!Number.isFinite(now.getTime())) return [];
  const windows: EnrollmentTimeWindow[] = [];
  const potential = xiaochanAdvanceWindow(offer, now);
  if (potential && Array.isArray(advanceWindows)) {
    for (const window of advanceWindows) {
      if (!window || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) || window.start >= window.end) continue;
      const start = Math.max(potential.start, window.start), end = Math.min(potential.end, window.end);
      if (start < end) windows.push({ start, end });
    }
  }
  const ordinary = todayEnrollmentWindow(offer, now);
  if (ordinary) windows.push(ordinary);
  windows.sort((a, b) => a.start - b.start);
  const merged: EnrollmentTimeWindow[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

export function defaultScheduleTime(offer: Offer, now = new Date(), advanceWindows: EnrollmentTimeWindow[] = []): string {
  const windows = scheduleTimeWindows(offer, now, advanceWindows);
  const first = windows.find(window => Math.ceil(window.start / 1000) * 1000 < window.end);
  if (!first) return "";
  const ordinary = todayEnrollmentWindow(offer, now);
  if (ordinary && first.start >= ordinary.start) return defaultEnrollmentTime(offer, now);
  return shanghaiDateTime(new Date(Math.ceil(first.start / 1000) * 1000));
}
