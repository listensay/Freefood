import type { Offer, RebateRule } from "../types";

export function assertCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
    throw new Error("金额必须是有效的非负整数分");
  }
  return value;
}

export function toCents(value: string | number): number {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error("请输入有效金额，最多两位小数");
  const [whole = "0", decimal = ""] = text.split(".");
  return assertCents(Number(whole) * 100 + Number(decimal.padEnd(2, "0")));
}

export function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function rebateFor(rule: RebateRule, eligibleCents: number): number {
  assertCents(eligibleCents);
  if (eligibleCents < rule.thresholdCents) return 0;
  if (rule.kind === "fixed") return rule.cashbackCents;
  // Integer cents and basis points avoid floating point errors. Round down conservatively.
  return Math.min(
    Math.floor((eligibleCents * rule.ratioBps) / 10_000),
    rule.capCents,
  );
}

export function activeAt(offer: Offer, now = new Date()): boolean {
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  if (
    offer.source === "live" &&
    (!Number.isFinite(Date.parse(offer.collectedAt)) ||
      day(new Date(offer.collectedAt)) !== day(now))
  )
    return false;
  if (offer.inventory !== undefined && offer.inventory <= 0) return false;
  if (!offer.startTime || !offer.endTime) return true;
  const minutes = (time: string) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!match) return NaN;
    const hour = Number(match[1]),
      minute = Number(match[2]);
    return hour <= 24 && minute < 60 && (hour !== 24 || minute === 0)
      ? hour * 60 + minute
      : NaN;
  };
  const start = minutes(offer.startTime),
    end = minutes(offer.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const current =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  if (start === end) return true;
  return end > start
    ? current >= start && current < end
    : current >= start || current < end;
}

export function calculatePrice(input: {
  paidCents: number;
  excludedFeesCents?: number;
  xiaochan: Offer;
  meituan: Offer;
  couponUsed?: boolean;
  sameStoreConfirmed?: boolean;
  stackingConfirmed?: boolean;
  now?: Date;
}) {
  const paid = assertCents(input.paidCents);
  const fees = assertCents(input.excludedFeesCents ?? 0);
  if (fees > paid) throw new Error("不计返现费用不能超过实付金额");
  const eligible = paid - fees;
  const xActive = activeAt(input.xiaochan, input.now);
  const mActive = activeAt(input.meituan, input.now);
  const x = xActive ? rebateFor(input.xiaochan.rule, eligible) : 0;
  const m =
    mActive && !input.couponUsed ? rebateFor(input.meituan.rule, eligible) : 0;
  const warnings: string[] = [];
  if (eligible < input.xiaochan.rule.thresholdCents)
    warnings.push("未达到小蚕返现门槛");
  if (eligible < input.meituan.rule.thresholdCents)
    warnings.push("未达到美团返现门槛");
  if (!xActive) warnings.push("小蚕活动当前不可用");
  if (!mActive) warnings.push("美团活动当前不可用");
  if (input.couponUsed)
    warnings.push("使用活动页优惠券，美团返现不适用");
  if (!input.sameStoreConfirmed) warnings.push("分店待确认");
  if (!input.stackingConfirmed)
    warnings.push("叠加条件待确认");
  return {
    paidCents: paid,
    eligibleCents: eligible,
    xiaochanCents: x,
    meituanCents: m,
    totalRebateCents: x + m,
    theoreticalNetCents: paid - x - m,
    singlePlatformNetCents: paid - Math.max(x, m),
    confirmedNetCents:
      input.sameStoreConfirmed && input.stackingConfirmed ? paid - x - m : null,
    warnings,
  };
}

export function ruleLabel(rule: RebateRule): string {
  return rule.kind === "fixed"
    ? `满 ${money(rule.thresholdCents)} 返 ${money(rule.cashbackCents)}`
    : `返 ${rule.ratioBps / 100}% · 最高 ${money(rule.capCents)}`;
}
