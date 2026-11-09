import type { Offer, Provider, RebateRule, ReviewBonus } from "../types";
import { assertCents } from "./pricing";

export function parseOffers(input: unknown, provider: Provider): Offer[] {
  if (!Array.isArray(input) || input.length > 500)
    throw new Error("数据必须是最多 500 条活动的 JSON 数组");
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("活动数据格式错误");
    const row = entry as Record<string, unknown>;
    if (row.activityKind !== undefined &&
      (row.activityKind !== "bawangcan" && row.activityKind !== "tasting" ||
        row.activityKind === "tasting" && provider === "xiaochan" ||
        row.activityKind === "bawangcan" && provider === "meituan"))
      throw new Error("活动类型无效");
    if (
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 200
    )
      throw new Error("每条活动需要有效的店铺名称");
    if (
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 200 ||
      seen.has(row.id)
    )
      throw new Error("活动 ID 必须存在且唯一");
    seen.add(row.id);
    const rule = row.rule as RebateRule | undefined;
    if (!rule || !["fixed", "percentage"].includes(rule.kind))
      throw new Error("需要 fixed 或 percentage 返现规则");
    assertCents(rule.thresholdCents);
    let validRule: RebateRule;
    if (rule.kind === "fixed") {
      validRule = {
        kind: "fixed",
        thresholdCents: rule.thresholdCents,
        cashbackCents: assertCents(rule.cashbackCents),
      };
    } else {
      if (
        !Number.isInteger(rule.ratioBps) ||
        rule.ratioBps < 0 ||
        rule.ratioBps > 10_000
      )
        throw new Error("返现比例需在 0–10000 基点之间");
      validRule = {
        kind: "percentage",
        thresholdCents: rule.thresholdCents,
        ratioBps: rule.ratioBps,
        capCents: assertCents(rule.capCents),
      };
    }
    if (
      row.inventory !== undefined &&
      (!Number.isInteger(row.inventory) || Number(row.inventory) < 0)
    )
      throw new Error("名额需要非负整数");
    let reviewBonus: ReviewBonus | undefined;
    if (row.reviewBonus !== undefined) {
      const bonus = row.reviewBonus as ReviewBonus;
      if (
        (provider !== "meituan" && !(provider === "waimai" && row.activityKind === "tasting")) ||
        !bonus ||
        !Number.isInteger(bonus.ratioBps) ||
        bonus.ratioBps < 0 ||
        bonus.ratioBps > 10_000
      )
        throw new Error("评价加返比例无效");
      reviewBonus = {
        ratioBps: bonus.ratioBps,
        capCents: assertCents(bonus.capCents),
      };
    }
    let product: Offer["product"];
    if (row.product !== undefined) {
      const value = row.product as Offer["product"];
      if (
        !value ||
        typeof value.name !== "string" ||
        !value.name.trim() ||
        value.name.length > 200
      )
        throw new Error("指定商品名称无效");
      product = {
        name: value.name.trim(),
        ...(value.priceCents === undefined
          ? {}
          : { priceCents: assertCents(value.priceCents) }),
      };
    }
    if (
      row.distanceMeters !== undefined &&
      (!Number.isFinite(row.distanceMeters) || Number(row.distanceMeters) < 0)
    )
      throw new Error("距离需要非负数字");
    const text = (key: string) =>
      typeof row[key] === "string"
        ? (row[key] as string).slice(0, 500)
        : undefined;
    for (const key of ["startTime", "endTime"]) {
      if (
        row[key] !== undefined &&
        !/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(String(row[key]))
      )
        throw new Error("活动时间需要 HH:mm 格式");
    }
    for (const key of ["validFrom", "validUntil"]) {
      if (
        row[key] !== undefined &&
        (typeof row[key] !== "string" || !Number.isFinite(Date.parse(row[key])))
      )
        throw new Error("活动有效期需要有效日期");
    }
    if (
      row.validFrom && row.validUntil &&
      Date.parse(String(row.validUntil)) <= Date.parse(String(row.validFrom))
    )
      throw new Error("活动结束时间需晚于开始时间");
    const poi = text("meituanPoiId");
    return {
      id: `${provider}:${row.id}`,
      provider,
      ...(row.activityKind ? { activityKind: row.activityKind as Offer["activityKind"] } : {}),
      name: row.name.trim(),
      rule: validRule,
      reviewBonus,
      product,
      category: text("category") || "其他",
      address: text("address"),
      meituanPoiId:
        poi && /^\d+$/.test(poi) && BigInt(poi) > 0 ? poi : undefined,
      image: safeUrl(text("image")),
      url: safeUrl(text("url")),
      inventory: row.inventory as number | undefined,
      distanceMeters: row.distanceMeters as number | undefined,
      startTime: text("startTime"),
      endTime: text("endTime"),
      validFrom: text("validFrom"),
      validUntil: text("validUntil"),
      requirement: text("requirement") || "请查看官方活动要求",
      collectedAt: new Date().toISOString(),
      source: "import",
    };
  });
}

export function safeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
