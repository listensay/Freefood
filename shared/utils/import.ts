import type { Offer, Provider, RebateRule } from "../types";
import { assertCents } from "./pricing";

export function parseOffers(input: unknown, provider: Provider): Offer[] {
  if (!Array.isArray(input) || input.length > 500)
    throw new Error("数据必须是最多 500 条活动的 JSON 数组");
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("活动数据格式错误");
    const row = entry as Record<string, unknown>;
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
    const poi = text("meituanPoiId");
    return {
      id: `${provider}:${row.id}`,
      provider,
      name: row.name.trim(),
      rule: validRule,
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

export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
