import type { Provider } from "../types";

const intervals: Record<Provider, number> = {
  xiaochan: 15 * 60_000,
  waimai: 5 * 60_000,
  meituan: 5 * 60_000,
};

export function nextAutomaticSyncTime(timestamp: number, provider: Provider): number {
  // Five- and fifteen-minute UTC boundaries also align with Asia/Shanghai wall time.
  const interval = intervals[provider];
  return (Math.floor(timestamp / interval) + 1) * interval;
}

export function nextAutomaticSyncCheck(timestamp: number): number {
  return Math.min(...Object.keys(intervals).map(provider => nextAutomaticSyncTime(timestamp, provider as Provider)));
}
