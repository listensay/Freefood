import type { Offer } from "../types";

export const shanghaiDateTime = (date: Date) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19);

const minutes = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return NaN;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour <= 24 && minute < 60 && (hour !== 24 || minute === 0) ? hour * 60 + minute : NaN;
};

export function todayEnrollmentWindow(offer: Offer, now = new Date()): { start: number; end: number } | undefined {
  if (offer.provider !== "xiaochan" || offer.source !== "live" ||
    !Number.isSafeInteger(offer.inventory) || (offer.inventory ?? 0) <= 0) return;
  const day = shanghaiDateTime(now).slice(0, 10);
  const collected = Date.parse(offer.collectedAt);
  const validFrom = offer.validFrom ? Date.parse(offer.validFrom) : undefined;
  const validUntil = offer.validUntil ? Date.parse(offer.validUntil) : undefined;
  if (!Number.isFinite(collected) || (validFrom !== undefined && !Number.isFinite(validFrom)) ||
    (validUntil !== undefined && !Number.isFinite(validUntil))) return;
  if (shanghaiDateTime(new Date(collected)).slice(0, 10) !== day &&
    (validFrom === undefined || shanghaiDateTime(new Date(validFrom)).slice(0, 10) !== day)) return;
  const midnight = Date.parse(`${day}T00:00:00+08:00`);
  let start = Math.max(now.getTime() + 1, validFrom ?? midnight);
  let end = Math.min(midnight + 24 * 3600_000, validUntil ?? Infinity);
  const first = offer.startTime ? minutes(offer.startTime) : undefined;
  const last = offer.endTime ? minutes(offer.endTime) : undefined;
  if ((first !== undefined && !Number.isFinite(first)) || (last !== undefined && !Number.isFinite(last))) return;
  if (first !== undefined && last !== undefined) {
    if (first < last) {
      start = Math.max(start, midnight + first * 60_000);
      end = Math.min(end, midnight + last * 60_000);
    } else if (first > last) {
      if (now.getTime() < midnight + last * 60_000) end = Math.min(end, midnight + last * 60_000);
      else start = Math.max(start, midnight + first * 60_000);
    }
  } else {
    if (first !== undefined) start = Math.max(start, midnight + first * 60_000);
    if (last !== undefined) end = Math.min(end, midnight + last * 60_000);
  }
  return start < end ? { start, end } : undefined;
}

export function defaultEnrollmentTime(offer: Offer, now = new Date()): string {
  const window = todayEnrollmentWindow(offer, now);
  if (!window) return "";
  const firstSecond = Math.ceil(window.start / 1000) * 1000;
  const lastSecond = Math.ceil(window.end / 1000) * 1000 - 1000;
  if (firstSecond > lastSecond) return "";
  const target = window.start > now.getTime() + 1 ? firstSecond : Math.min(lastSecond, Math.ceil((now.getTime() + 60_000) / 1000) * 1000);
  return shanghaiDateTime(new Date(target));
}

export function canScheduleEnrollment(offer: Offer, runAt: Date, now = new Date()): boolean {
  const time = runAt.getTime();
  if (!Number.isFinite(time) || shanghaiDateTime(runAt).slice(0, 10) !== shanghaiDateTime(now).slice(0, 10)) return false;
  const window = todayEnrollmentWindow(offer, now);
  return !!window && time >= window.start && time < window.end;
}
