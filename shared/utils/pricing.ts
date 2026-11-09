import type { Offer, RebateRule, ReviewBonus } from "../types";
import { isTastingOffer, providerShortNames } from "../types";

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
  if (
    offer.validFrom &&
    (!Number.isFinite(Date.parse(offer.validFrom)) || now.getTime() < Date.parse(offer.validFrom))
  )
    return false;
  if (
    offer.validUntil &&
    (!Number.isFinite(Date.parse(offer.validUntil)) || now.getTime() >= Date.parse(offer.validUntil))
  )
    return false;
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

type PriceInput = {
  paidCents: number;
  excludedFeesCents?: number;
  meituan: Offer;
  includeReviewBonus?: boolean;
  productConfirmed?: boolean;
  sameStoreConfirmed?: boolean;
  stackingConfirmed?: boolean;
  now?: Date;
} & (
  | { bawangcan: Offer; xiaochan?: never }
  | { xiaochan: Offer; bawangcan?: never }
);

export function calculatePrice(input: PriceInput) {
  return priceFor(input, "current");
}

export function estimatePrice(input: PriceInput) {
  return priceFor(input, "rules");
}

function priceFor(input: PriceInput, availability: "current" | "rules") {
  const bawangcan = input.bawangcan ?? input.xiaochan;
  if (isTastingOffer(bawangcan)) throw new Error("请选择霸王餐活动");
  if (!isTastingOffer(input.meituan) || bawangcan.provider === input.meituan.provider)
    throw new Error("请选择不同平台的试吃官活动");
  const name = providerShortNames[bawangcan.provider];
  const tastingName = providerShortNames[input.meituan.provider];
  const paid = assertCents(input.paidCents);
  const fees = assertCents(input.excludedFeesCents ?? 0);
  if (fees > paid) throw new Error("不计返现费用不能超过实付金额");
  const eligible = paid - fees;
  const xActive = activeAt(bawangcan, input.now);
  const mActive = activeAt(input.meituan, input.now);
  // Rule quotes stay comparable before the activity starts; current eligibility still supplies warnings.
  const xEligible = availability === "rules" || xActive;
  const mEligible = availability === "rules" || mActive;
  const x = xEligible ? rebateFor(bawangcan.rule, eligible) : 0;
  const mBase = mEligible ? rebateFor(input.meituan.rule, eligible) : 0;
  const bonus = input.meituan.reviewBonus;
  const mReview =
    bonus &&
    mEligible &&
    input.includeReviewBonus !== false &&
    eligible >= input.meituan.rule.thresholdCents
      ? rebateFor({ kind: "percentage", thresholdCents: 0, ...bonus }, eligible)
      : 0;
  const m = mBase + mReview;
  const balance = x + m - paid;
  const warnings: string[] = [];
  if (eligible < bawangcan.rule.thresholdCents)
    warnings.push(`未达到${name}返现门槛`);
  if (eligible < input.meituan.rule.thresholdCents)
    warnings.push(`未达到${tastingName}返现门槛`);
  if (!xActive) warnings.push(`${name}活动当前不可用`);
  if (!mActive) warnings.push(`${tastingName}活动当前不可用`);
  if (!input.sameStoreConfirmed) warnings.push("分店待确认");
  if (!input.stackingConfirmed) warnings.push("叠加条件待确认");
  if (bawangcan.product && !input.productConfirmed)
    warnings.push("指定商品待确认");
  return {
    paidCents: paid,
    eligibleCents: eligible,
    bawangcanCents: x,
    xiaochanCents: bawangcan.provider === "xiaochan" ? x : 0,
    waimaiCents: bawangcan.provider === "waimai" ? x : input.meituan.provider === "waimai" ? m : 0,
    tastingCents: m,
    meituanCents: input.meituan.provider === "meituan" ? m : 0,
    meituanBaseCents: input.meituan.provider === "meituan" ? mBase : 0,
    meituanReviewCents: input.meituan.provider === "meituan" ? mReview : 0,
    totalRebateCents: x + m,
    balanceCents: balance,
    theoreticalNetCents: paid - x - m,
    singlePlatformNetCents: paid - Math.max(x, m),
    confirmedNetCents:
      input.sameStoreConfirmed &&
      input.stackingConfirmed &&
      (!bawangcan.product || input.productConfirmed)
        ? paid - x - m
        : null,
    warnings,
  };
}

export function reviewBonusLabel(bonus: ReviewBonus): string {
  return `评价加返 ${bonus.ratioBps / 100}% · 最高 ${money(bonus.capCents)}`;
}

export function suggestedPaidCents(bawangcan: Offer): number {
  return Math.max(
    bawangcan.rule.thresholdCents,
    bawangcan.product?.priceCents ?? 0,
  );
}

export function priceOutcome(balanceCents: number) {
  return {
    kind: balanceCents > 0 ? "income" : balanceCents < 0 ? "expense" : "balanced",
    label: balanceCents > 0 ? "预计收益" : balanceCents < 0 ? "预计支出" : "收支平衡",
    amountCents: Math.abs(balanceCents),
  };
}

export function ruleLabel(rule: RebateRule): string {
  return rule.kind === "fixed"
    ? `满 ${money(rule.thresholdCents)} 返 ${money(rule.cashbackCents)}`
    : `返 ${rule.ratioBps / 100}% · 最高 ${money(rule.capCents)}`;
}
