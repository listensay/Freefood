import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Offer } from "../shared/types";
import {
  activeAt,
  calculatePrice,
  estimatePrice,
  priceOutcome,
  rebateFor,
  toCents,
  suggestedPaidCents,
} from "../shared/utils/pricing";
import { groupStoreMatches, matchStores } from "../shared/utils/matching";
import { parseOffers, csvCell } from "../shared/utils/import";
import {
  normalizeXiaochan,
  fetchXiaochan,
} from "../server/utils/xiaochan";
import type { XiaochanAccount } from "../server/utils/xiaochan-rpc";
import { addressFromGeocode, toGcj02 } from "../shared/utils/location";
import { matchWithinRadius, offerWithinRadius } from "../shared/utils/scope";
import { collectActivityPages } from "../server/utils/activity-pages";
import { normalizeMeituan } from "../server/utils/meituan";

const testXiaochanAccount = (changes: Partial<XiaochanAccount> = {}): XiaochanAccount => ({
  silkId: "123456789", userId: "6789", accessToken: "private-test-token",
  platform: "mini", version: "3.22.2.83", sessionId: "private-test-session",
  ...changes,
});
const now = new Date("2026-11-04T04:00:00Z");
const x: Offer = {
  id: "x1",
  provider: "xiaochan",
  name: "好饭（科技园店）",
  category: "美食",
  meituanPoiId: "111",
  rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 2000 },
  inventory: 5,
  requirement: "无需评价",
  collectedAt: now.toISOString(),
  source: "import",
};
const m: Offer = {
  ...x,
  id: "m1",
  provider: "meituan",
  rule: {
    kind: "percentage",
    thresholdCents: 0,
    ratioBps: 3500,
    capCents: 1200,
  },
};
const calculate = (extra = {}) =>
  calculatePrice({ paidCents: 2500, xiaochan: x, meituan: m, now, ...extra });

test("money is represented in integer cents", () => {
  assert.equal(toCents("0.29"), 29);
  assert.equal(toCents("28.00"), 2800);
  assert.throws(() => toCents("2.001"));
  assert.throws(() => toCents("-1"));
  assert.throws(() => toCents("1e3"));
});
test("stack calculation keeps theoretical negative net without promising cashback", () => {
  const r = calculate();
  assert.equal(r.xiaochanCents, 2000);
  assert.equal(r.meituanCents, 875);
  assert.equal(r.theoreticalNetCents, -375);
  assert.equal(r.confirmedNetCents, null);
  assert.equal(r.singlePlatformNetCents, 500);
  assert.equal(r.balanceCents, 375);
});
test("rule quotes distinguish income, expense and break-even at the Bawangcan requirement", () => {
  const meituan = {
    ...m,
    reviewBonus: { ratioBps: 500, capCents: 100 },
  };
  for (const [cashbackCents, balanceCents, kind, label] of [
    [1300, 100, "income", "预计收益"],
    [1000, -200, "expense", "预计支出"],
    [1200, 0, "balanced", "收支平衡"],
  ] as const) {
    const bawangcan: Offer = {
      ...x,
      rule: { kind: "fixed", thresholdCents: 2000, cashbackCents },
    };
    const result = estimatePrice({
      paidCents: suggestedPaidCents(bawangcan),
      bawangcan,
      meituan,
      now,
    });
    assert.equal(result.paidCents, 2000);
    assert.equal(result.bawangcanCents, cashbackCents);
    assert.equal(result.meituanBaseCents, 700);
    assert.equal(result.meituanReviewCents, 100);
    assert.equal(result.balanceCents, balanceCents);
    assert.equal(result.balanceCents + result.theoreticalNetCents, 0);
    assert.deepEqual(priceOutcome(result.balanceCents), {
      kind,
      label,
      amountCents: Math.abs(balanceCents),
    });
  }
});
test("rule quotes convert Meituan rates at the order amount and cap both rewards separately", () => {
  const result = estimatePrice({
    paidCents: 2000,
    bawangcan: {
      ...x,
      rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1300 },
    },
    meituan: {
      ...m,
      rule: { ...m.rule, kind: "percentage", ratioBps: 3500, capCents: 600 },
      reviewBonus: { ratioBps: 500, capCents: 50 },
    },
    now,
  });
  assert.equal(result.meituanBaseCents, 600);
  assert.equal(result.meituanReviewCents, 50);
  assert.equal(result.balanceCents, -50);
});
test("rule quotes retain fee, review-task and higher Meituan threshold checks", () => {
  const meituan = { ...m, reviewBonus: { ratioBps: 500, capCents: 100 } };
  const input = { paidCents: suggestedPaidCents(x), bawangcan: x, meituan, now };
  assert.equal(estimatePrice({ ...input, includeReviewBonus: false }).balanceCents, 375);
  const fees = estimatePrice({ ...input, excludedFeesCents: 100 });
  assert.equal(fees.bawangcanCents, 0);
  assert.equal(fees.meituanCents, 940);
  assert.equal(fees.balanceCents, -1560);
  const higherThreshold = estimatePrice({
    ...input,
    meituan: { ...meituan, rule: { ...m.rule, thresholdCents: 3000 } },
  });
  assert.equal(higherThreshold.paidCents, 2500);
  assert.equal(higherThreshold.meituanCents, 0);
  assert.ok(higherThreshold.warnings.includes("未达到美团返现门槛"));
  assert.throws(() => estimatePrice({ ...input, paidCents: -1 }));
  assert.throws(() => estimatePrice({ ...input, excludedFeesCents: 3000 }));
});
test("both confirmations required for confirmed estimate", () => {
  assert.equal(calculate({ sameStoreConfirmed: true }).confirmedNetCents, null);
  assert.equal(
    calculate({ sameStoreConfirmed: true, stackingConfirmed: true })
      .confirmedNetCents,
    -375,
  );
});
test("calculation warnings use concise state labels", () => {
  assert.deepEqual(calculate().warnings, ["分店待确认", "叠加条件待确认"]);
  assert.deepEqual(
    calculate({
      sameStoreConfirmed: true,
      stackingConfirmed: true,
    }).warnings,
    [],
  );
  assert.ok(
    calculate({ xiaochan: { ...x, inventory: 0 } }).warnings.includes(
      "小蚕活动当前不可用",
    ),
  );
});
test("excluded fees affect threshold and ratio, not actual paid", () => {
  const r = calculate({ excludedFeesCents: 100 });
  assert.equal(r.eligibleCents, 2400);
  assert.equal(r.xiaochanCents, 0);
  assert.equal(r.meituanCents, 840);
  assert.equal(r.paidCents, 2500);
  assert.throws(() => calculate({ excludedFeesCents: 3000 }));
});
test("percentage cashback applies cap and floors fractional cents", () => {
  assert.equal(rebateFor(m.rule, 5000), 1200);
  assert.equal(rebateFor(m.rule, 101), 35);
});
test("Meituan review bonus has an independent percentage cap and can be excluded", () => {
  const offer = { ...m, reviewBonus: { ratioBps: 500, capCents: 100 } };
  const result = calculate({ meituan: offer });
  assert.equal(result.meituanBaseCents, 875);
  assert.equal(result.meituanReviewCents, 100);
  assert.equal(result.meituanCents, 975);
  assert.equal(result.theoreticalNetCents, -475);
  assert.equal(
    calculate({ meituan: offer, includeReviewBonus: false }).meituanCents,
    875,
  );
  assert.equal(
    calculate({ meituan: { ...offer, inventory: 0 } }).meituanReviewCents,
    0,
  );
  assert.equal(
    calculate({
      meituan: { ...offer, rule: { ...m.rule, thresholdCents: 3000 } },
    }).meituanReviewCents,
    0,
  );
  const capped = calculate({ paidCents: 5000, meituan: offer });
  assert.equal(capped.meituanBaseCents, 1200);
  assert.equal(capped.meituanReviewCents, 100);
  assert.equal(capped.meituanCents, 1300);
  assert.equal(
    calculate({ paidCents: 101, meituan: offer }).meituanReviewCents,
    5,
  );
});
test("Meituan imports validate optional review bonuses without changing other providers", () => {
  const row = { ...m, id: "1", reviewBonus: { ratioBps: 500, capCents: 100 } };
  assert.deepEqual(
    parseOffers([row], "meituan")[0]?.reviewBonus,
    row.reviewBonus,
  );
  for (const bonus of [
    { ratioBps: -1, capCents: 100 },
    { ratioBps: 10001, capCents: 100 },
    { ratioBps: 500, capCents: -1 },
    null,
  ])
    assert.throws(() =>
      parseOffers([{ ...row, reviewBonus: bonus }], "meituan"),
    );
  assert.throws(() => parseOffers([row], "xiaochan"));
});
test("product cashback compares the supplied product price and requires product confirmation", () => {
  const productOffer = {
    ...x,
    product: { name: "测试商品", priceCents: 890 },
    rule: { kind: "fixed", thresholdCents: 0, cashbackCents: 600 } as const,
  };
  assert.equal(suggestedPaidCents(productOffer), 890);
  const quote = estimatePrice({
    paidCents: suggestedPaidCents(productOffer),
    bawangcan: productOffer,
    meituan: m,
    now,
  });
  assert.equal(quote.bawangcanCents, 600);
  assert.equal(quote.meituanCents, 311);
  assert.equal(quote.balanceCents, 21);
  const result = calculate({
    paidCents: 890,
    xiaochan: productOffer,
    sameStoreConfirmed: true,
    stackingConfirmed: true,
  });
  assert.equal(result.confirmedNetCents, null);
  assert.ok(result.warnings.includes("指定商品待确认"));
  assert.equal(
    calculate({
      paidCents: 890,
      xiaochan: productOffer,
      sameStoreConfirmed: true,
      stackingConfirmed: true,
      productConfirmed: true,
    }).confirmedNetCents,
    result.theoreticalNetCents,
  );
});
test("paged activity collection merges all pages and retains the inclusive 7km boundary", async () => {
  const visited: number[] = [];
  const make = (id: string, distanceMeters?: number) => ({
    ...x,
    id,
    distanceMeters,
  });
  const offers = await collectActivityPages(
    async (page) => {
      visited.push(page);
      return [
        {
          offers: [make("near", 1000), make("far", 7001)],
          rowKeys: ["near", "far"],
        },
        {
          offers: [make("near", 1000), make("edge", 7000), make("unknown")],
          rowKeys: ["near", "edge", "unknown"],
        },
        { offers: [], rowKeys: [] },
      ][page]!;
    },
    7000,
    { delayMs: 0 },
  );
  assert.deepEqual(visited, [0, 1, 2]);
  assert.deepEqual(
    offers.map((offer) => offer.id),
    ["near", "edge"],
  );
  assert.equal(offerWithinRadius(make("edge", 7000), 7000), true);
  assert.equal(
    matchWithinRadius(
      {
        id: "pair",
        bawangcan: make("unknown"),
        meituan: { ...m, distanceMeters: 7000 },
        confidence: "id",
        reason: "",
      },
      7000,
    ),
    true,
  );
  assert.equal(
    matchWithinRadius(
      {
        id: "pair",
        bawangcan: make("far", 7001),
        meituan: { ...m, distanceMeters: 7000 },
        confidence: "id",
        reason: "",
      },
      7000,
    ),
    false,
  );
});
test("paged activity collection does not present stalled, capped or failed scans as complete", async () => {
  await assert.rejects(
    collectActivityPages(
      async () => ({ offers: [x], rowKeys: ["same"] }),
      7000,
      { delayMs: 0 },
    ),
    /分页未更新/,
  );
  await assert.rejects(
    collectActivityPages(
      async (page) => ({ offers: [], rowKeys: [String(page)] }),
      7000,
      { maxPages: 2, delayMs: 0 },
    ),
    /未加载完整/,
  );
  await assert.rejects(
    collectActivityPages(
      async (page) => {
        if (page) throw new Error("failed second page");
        return { offers: [x], rowKeys: ["1"] };
      },
      7000,
      { delayMs: 0 },
    ),
    /failed second page/,
  );
});
test("zero inventory disables rebate", () => {
  assert.equal(
    calculate({ xiaochan: { ...x, inventory: 0 } }).xiaochanCents,
    0,
  );
});
test("activity time uses Shanghai timezone and handles overnight and 24:00", () => {
  assert.equal(
    activeAt({ ...x, startTime: "11:00", endTime: "13:00" }, now),
    true,
  );
  assert.equal(
    activeAt({ ...x, startTime: "13:00", endTime: "14:00" }, now),
    false,
  );
  assert.equal(
    activeAt({ ...x, startTime: "00:00", endTime: "24:00" }, now),
    true,
  );
  assert.equal(
    activeAt(
      { ...x, startTime: "23:00", endTime: "02:00" },
      new Date("2026-11-04T17:00:00Z"),
    ),
    true,
  );
  assert.equal(
    activeAt({ ...x, startTime: "oops", endTime: "24:00" }, now),
    false,
  );
});
test("upcoming synced activities remain matchable without granting early cashback", () => {
  const morning = new Date("2026-11-05T00:30:00Z");
  const upcoming: Offer = {
    ...x,
    source: "live",
    collectedAt: morning.toISOString(),
    distanceMeters: 1200,
    startTime: "11:00",
    endTime: "14:00",
    validFrom: "2026-11-05T03:00:00Z",
    validUntil: "2026-11-05T06:00:00Z",
  };
  const meituan: Offer = {
    ...m,
    source: "live",
    collectedAt: morning.toISOString(),
    distanceMeters: 1200,
  };
  const matches = matchStores([upcoming], [meituan]).filter((match) =>
    matchWithinRadius(match, 7000),
  );
  assert.equal(matches.length, 1);
  assert.equal(activeAt(upcoming, morning), false);
  assert.equal(activeAt(meituan, morning), true);
  const price = (time: Date) =>
    calculatePrice({
      paidCents: 2500,
      bawangcan: upcoming,
      meituan,
      now: time,
    });
  assert.equal(price(morning).bawangcanCents, 0);
  assert.equal(price(new Date("2026-11-05T04:00:00Z")).bawangcanCents, 2000);
  const quote = estimatePrice({
    paidCents: 2500,
    bawangcan: upcoming,
    meituan,
    now: morning,
  });
  assert.equal(quote.bawangcanCents, 2000);
  assert.equal(quote.meituanCents, 875);
  assert.equal(quote.balanceCents, 375);
  assert.ok(quote.warnings.includes("小蚕活动当前不可用"));
  const unavailableQuote = estimatePrice({
    paidCents: 2500,
    bawangcan: { ...upcoming, inventory: 0 },
    meituan,
    now: morning,
  });
  assert.equal(unavailableQuote.balanceCents, quote.balanceCents);
  assert.ok(unavailableQuote.warnings.includes("小蚕活动当前不可用"));
});
test("same shared ID matches; conflicting shared IDs never fall back to name", () => {
  assert.equal(matchStores([x], [m])[0]?.confidence, "id");
  assert.equal(matchStores([x], [{ ...m, meituanPoiId: "222" }]).length, 0);
});
test("full names match after punctuation normalization but still require confirmation", () => {
  const a = { ...x, meituanPoiId: undefined };
  assert.equal(
    matchStores(
      [a],
      [{ ...m, meituanPoiId: undefined, name: "好饭 (科技园店)" }],
    )[0]?.confidence,
    "name",
  );
});
test("different branches of same chain do not match", () => {
  assert.equal(
    matchStores(
      [{ ...x, meituanPoiId: undefined }],
      [{ ...m, meituanPoiId: undefined, name: "好饭（后海店）" }],
    ).length,
    0,
  );
});
test("multiple platform activities stay separate combinations", () => {
  assert.equal(
    matchStores([x, { ...x, id: "x2" }], [m, { ...m, id: "m2" }]).length,
    4,
  );
});
test("same-store price variants share a card without losing rules or activity matches", () => {
  const second: Offer = {
    ...x,
    id: "x2",
    rule: { kind: "fixed", thresholdCents: 2600, cashbackCents: 1200 },
  };
  const matches = matchStores([x, second], [m, { ...m, id: "m2" }]);
  const groups = groupStoreMatches(matches);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.matches, matches);
  assert.equal(groups[0]!.matches[2]!.bawangcan, second);
  assert.equal(groups[0]!.id, groupStoreMatches([...matches].reverse())[0]!.id);
  assert.deepEqual(groups[0]!.matches.map(match => suggestedPaidCents(match.bawangcan)), [2500, 2500, 2600, 2600]);
});
test("grouping keeps different products, branches and providers on separate cards", () => {
  const offers: Offer[] = [
    { ...x, product: { name: "鸡腿饭", priceCents: 2500 } },
    { ...x, id: "x2", product: { name: "鸡腿饭", priceCents: 2600 } },
    { ...x, id: "x3", product: { name: "牛肉饭", priceCents: 2600 } },
    { ...x, id: "x4", meituanPoiId: "222", name: "好饭（后海店）" },
    { ...x, id: "x5", provider: "waimai" },
  ];
  const groups = groupStoreMatches(matchStores(offers, [m, { ...m, id: "m2", meituanPoiId: "222", name: "好饭（后海店）" }]));
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map(group => group.matches.length), [2, 1, 1, 1]);
});
test("name matches remain separated by merchant address and opaque Meituan identity", () => {
  const offers = [
    { ...x, meituanPoiId: undefined, address: "科技园路 1 号" },
    { ...x, id: "x2", meituanPoiId: undefined, address: "科技园路 2 号" },
  ];
  const meituan = [
    { ...m, meituanPoiId: undefined, opaquePoiId: "store-a" },
    { ...m, id: "m2", meituanPoiId: undefined, opaquePoiId: "store-b" },
  ];
  assert.equal(groupStoreMatches(matchStores(offers, meituan)).length, 4);
});
test("JSON import validates money, unique IDs, time, inventory and safe URLs", () => {
  const row = {
    id: "1",
    name: "店铺",
    rule: x.rule,
    image: "javascript:alert(1)",
    meituanPoiId: "-100",
  };
  assert.equal(parseOffers([row], "xiaochan")[0]?.image, undefined);
  assert.equal(parseOffers([row], "xiaochan")[0]?.meituanPoiId, undefined);
  assert.throws(() => parseOffers([row, row], "xiaochan"));
  assert.throws(() => parseOffers([{ ...row, inventory: -1 }], "xiaochan"));
  assert.throws(() =>
    parseOffers([{ ...row, startTime: "99:00" }], "xiaochan"),
  );
  assert.throws(() =>
    parseOffers(
      [{ ...row, rule: { ...x.rule, thresholdCents: 0.1 } }],
      "xiaochan",
    ),
  );
  assert.throws(() =>
    parseOffers([{ ...row, rule: { ...m.rule, ratioBps: 35000 } }], "meituan"),
  );
});
test("CSV protects against spreadsheet formula injection", () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("-3.75"), '"\'-3.75"');
});
test("Xiaochan adapter excludes Eleme and affiliate commission to avoid false stacking", () => {
  const row = {
    source: 1,
    store_platform: 1,
    promotion_id: "789",
    store: { name: x.name, id: 99 },
    order_money: 2500,
    user_rebate: 2000,
    left_number: 3,
  };
  const result = normalizeXiaochan({
    feed_items: [row, { ...row, source: 5 }, { ...row, store_platform: 2 }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.meituanPoiId, undefined);
  assert.equal(result[0]?.rule.kind, "fixed");
  assert.throws(() => normalizeXiaochan({ new_schema: [] }));
});
const capturedXiaochanRow = {
  source: 1,
  store_platform: 1,
  promotion_id: "123",
  store: {
    name: "测试店（南宁店）",
    id: 99,
    store_info: { meituan_info: { meituan_poi_id: "-100" } },
  },
  order_money: 2000,
  user_rebate: 1500,
  left_number: 3,
  start_time_hour: "08:00",
  end_time_hour: "23:59",
  rebate_condition: 2,
};
test("Xiaochan live feed preserves captured times and excludes unrelated promotions", () => {
  const offers = normalizeXiaochan({ feed_items: [
    capturedXiaochanRow,
    { ...capturedXiaochanRow, source: 5 },
    { ...capturedXiaochanRow, source: 3 },
    { ...capturedXiaochanRow, store_platform: 2 },
  ] });
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.source, "live");
  assert.equal(offers[0]?.startTime, "08:00");
  assert.equal(offers[0]?.endTime, "23:59");
  assert.equal(normalizeXiaochan({ feed_items: [{
    ...capturedXiaochanRow, start_time_hour: 8, start_time_minute: 5,
  }] })[0]?.startTime, "08:05");
});
test("Xiaochan product offers use the explicit product price without inventing an order threshold", () => {
  const row: any = {
    ...capturedXiaochanRow,
    user_rebate: 600,
    store_product: {
      name: "测试商品",
      detail: { sku_price: "16.1", full_discount_price: "8.9" },
    },
  };
  delete row.order_money;
  const [offer] = normalizeXiaochan({ feed_items: [row] });
  assert.deepEqual(offer?.product, { name: "测试商品", priceCents: 890 });
  assert.deepEqual(offer?.rule, {
    kind: "fixed",
    thresholdCents: 0,
    cashbackCents: 600,
  });
  assert.deepEqual(
    normalizeXiaochan({ feed_items: [{ ...row, store_product: {} }] }),
    [],
  );
});
test("Xiaochan product offers fall back to the SKU price when the discount is unavailable", () => {
  for (const full_discount_price of [-1, "-1.0", undefined, null, ""]) {
    const [offer] = normalizeXiaochan({ feed_items: [{
      ...capturedXiaochanRow,
      store_product: {
        name: "测试商品",
        detail: { full_discount_price, sku_price: "19.8" },
      },
    }] });
    assert.equal(offer?.product?.priceCents, 1980);
  }
  const productOffer = (full_discount_price: unknown, sku_price: unknown) =>
    normalizeXiaochan({ feed_items: [{
      ...capturedXiaochanRow,
      store_product: {
        name: "测试商品",
        detail: { full_discount_price, sku_price },
      },
    }] });
  assert.equal(productOffer("0", "19.8")[0]?.product?.priceCents, 0);
  for (const [discount, sku] of [["-2", "19.8"], ["invalid", "19.8"], ["-1.0", "19.801"]])
    assert.throws(() => productOffer(discount, sku), /小蚕商品价格异常/);
});
test("Xiaochan retains product requirements without a SKU price and quotes the explicit order threshold", () => {
  const [offer] = normalizeXiaochan({ feed_items: [{
    ...capturedXiaochanRow,
    store_product: { name: "测试商品" },
  }] });
  assert.deepEqual(offer?.product, { name: "测试商品" });
  assert.equal(suggestedPaidCents(offer!), 2000);
  const result = estimatePrice({
    paidCents: suggestedPaidCents(offer!),
    bawangcan: offer!,
    meituan: m,
    now,
    sameStoreConfirmed: true,
    stackingConfirmed: true,
  });
  assert.equal(result.bawangcanCents, 1500);
  assert.equal(result.confirmedNetCents, null);
  assert.ok(result.warnings.includes("指定商品待确认"));
  assert.deepEqual(parseOffers([offer], "xiaochan")[0]?.product, offer?.product);
  assert.deepEqual(normalizeXiaochan({ feed_items: [{
    ...capturedXiaochanRow,
    order_money: undefined,
    store_product: { name: "测试商品" },
  }] }), []);
});
test("Xiaochan skips unavailable product entries without discarding other activity rules", () => {
  const unavailable = { ...capturedXiaochanRow, order_money: undefined, store_product: {} };
  const offers = normalizeXiaochan({ feed_items: [unavailable, { ...capturedXiaochanRow, promotion_id: "available" }] });
  assert.deepEqual(offers.map(offer => offer.id), ["xiaochan:available"]);
  assert.equal(offers[0]?.rule.thresholdCents, 2000);
  assert.throws(() => normalizeXiaochan({ feed_items: [{ ...unavailable, store_product: undefined }] }));
  assert.throws(() => normalizeXiaochan({ feed_items: [{ ...capturedXiaochanRow, order_money: "invalid" }] }));
});
test("Xiaochan radius sync ignores unusable prices outside the requested area while continuing pagination", async (t) => {
  const offsets: number[] = [];
  t.mock.method(globalThis, "fetch", async (_, init: RequestInit) => {
    const offset = JSON.parse(String(init.body)).offset;
    offsets.push(offset);
    return Response.json({ status: { code: 0 }, feed_items: offset === 0
      ? [{ ...capturedXiaochanRow, distance: 7001, store_product: { name: "范围外商品", detail: { sku_price: "invalid" } } }]
      : offset === 20
        ? [{ ...capturedXiaochanRow, promotion_id: "near", distance: 7000 }]
        : [] });
  });
  const offers = await fetchXiaochan(testXiaochanAccount(), {
    label: "测试地址", cityCode: 310000, latitude: 31.23, longitude: 121.47,
  }, { radiusMeters: 7000 });
  assert.deepEqual(offsets, [0, 20, 40]);
  assert.deepEqual(offers.map(offer => offer.id), ["xiaochan:near"]);
});
test("activity import rejects Xiaochan response bodies instead of converting them", () => {
  for (const input of [
    { status: { code: 0 }, feed_items: [capturedXiaochanRow] },
    { status: { code: 0 }, promotion_list: [] },
    [capturedXiaochanRow],
  ]) assert.throws(() => parseOffers(input, "xiaochan"));
});
test("live Xiaochan activities retain absolute validity instead of recurring on later days", () => {
  const start = new Date("2026-11-04T00:00:00+08:00"),
    end = new Date("2026-11-05T00:00:00+08:00");
  const [normalized] = normalizeXiaochan({
    feed_items: [
      {
        ...capturedXiaochanRow,
        start_timestamp: start.getTime() / 1000,
        end_timestamp: end.getTime() / 1000,
      },
    ],
  });
  const offer = { ...normalized!, collectedAt: start.toISOString() };
  assert.equal(offer.validUntil, end.toISOString());
  assert.equal(activeAt(offer!, new Date("2026-11-04T12:00:00+08:00")), true);
  assert.equal(activeAt(offer!, new Date("2026-11-05T12:00:00+08:00")), false);
  assert.equal(activeAt(offer!, new Date("2026-11-03T12:00:00+08:00")), false);
});
test("Xiaochan generates request parameters from the saved location without captured request body", async (t) => {
  const location = {
    label: "南宁",
    cityCode: 450103,
    latitude: 22.82,
    longitude: 108.36,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gw.xiaocantech.com/rpc");
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-city"), "450103");
    assert.equal(headers.get("content-length"), null);
    assert.equal(headers.get("xweb_xhr"), "1");
    assert.equal(headers.get("methodname"), "FusionService.GetFeedPromotions");
    const body = JSON.parse(String(init.body));
    assert.equal(body.lat, location.latitude);
    assert.equal(body.lon, location.longitude);
    assert.equal(body.silk_id, 123456);
    return Response.json({
      status: { code: 0 },
      feed_items: [capturedXiaochanRow],
    });
  });
  const result = await fetchXiaochan(
    testXiaochanAccount({ silkId: "123456" }),
    location,
  );
  assert.equal(result[0]?.source, "live");
  assert.equal(result[0]?.startTime, "08:00");
});
test("Xiaochan feed body matches the captured mini-program schema and numeric types", async (t) => {
  let sent: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sent = init;
    return Response.json({ status: { code: 0 }, feed_items: [] });
  });
  const session = testXiaochanAccount();
  const location = {
    label: "测试地址",
    cityCode: 450103,
    latitude: 22.12345,
    longitude: 108.123456,
  };
  await fetchXiaochan(session, location);
  assert.equal(
    sent?.body,
    JSON.stringify({
      silk_id: 123456789,
      lon: location.longitude,
      lat: location.latitude,
      number: 20,
      offset: 0,
      sort: 0,
      scene: 1,
      is_show_mt: true,
      app_id: 20,
    }),
  );
  assert.equal(Buffer.byteLength(String(sent?.body)), 125);
  assert.equal(new Headers(sent?.headers).get("content-length"), null);
});
test("Xiaochan radius sync continues past mixed pages with no eligible offers", async (t) => {
  const offsets: number[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const offset = JSON.parse(String(init.body)).offset;
      offsets.push(offset);
      const rows =
        offset === 0
          ? [{ source: 5, wm_poi_id: "affiliate-only" }]
          : offset === 20
            ? [
                { ...capturedXiaochanRow, distance: 7000 },
                { ...capturedXiaochanRow, promotion_id: "far", distance: 7001 },
              ]
            : [];
      return Response.json(
        rows.length
          ? { status: { code: 0 }, feed_items: rows }
          : { status: { code: 0 } },
      );
    },
  );
  const offers = await fetchXiaochan(
    testXiaochanAccount(),
    { label: "测试地址", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
    { radiusMeters: 7000 },
  );
  assert.deepEqual(offsets, [0, 20, 40]);
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.distanceMeters, 7000);
  assert.deepEqual(normalizeXiaochan({ status: { code: 0 } }), []);
  assert.throws(() =>
    normalizeXiaochan({ status: { code: 0 }, new_schema: [] }),
  );
});
test("Xiaochan refreshes a 16-character nonce and signs the same values sent upstream", async (t) => {
  const md5 = (text: string) => createHash("md5").update(text).digest("hex");
  const location = {
    label: "南宁",
    cityCode: 450103,
    latitude: 22.82,
    longitude: 108.36,
  };
  const session = testXiaochanAccount();
  const original = { ...session };
  const nonces = new Set<string>();
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      requests.push(init);
      return Response.json({ status: { code: 0 }, feed_items: [] });
    },
  );
  await fetchXiaochan(session, location);
  await fetchXiaochan(session, location);
  for (const init of requests) {
    const headers = new Headers(init.headers);
    const nonce = headers.get("x-nami")!;
    assert.match(nonce, /^[a-f0-9]{4}123456789[a-f0-9]{3}$/);
    assert.equal(nonce.length, 16);
    assert.ok(!nonces.has(nonce));
    nonces.add(nonce);
    const timestamp = headers.get("x-garen")!;
    assert.ok(Math.abs(Number(timestamp) - Date.now()) < 5000);
    const method =
      `${headers.get("servername")}.${headers.get("methodname")}`.toLowerCase();
    assert.equal(headers.get("x-ashe"), md5(md5(method) + timestamp + nonce));
    assert.equal(headers.get("x-sivir"), "private-test-token");
    assert.equal(headers.get("x-session-id"), "private-test-session");
    assert.equal(headers.get("x-version"), "3.22.2.83");
    assert.equal(JSON.parse(String(init.body)).silk_id, 123456789);
  }
  assert.deepEqual(session, original);
});
test("Xiaochan nonce remains 16 characters for supported device ID lengths", async (t) => {
  const nonces: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      nonces.push(new Headers(init.headers).get("x-nami")!);
      return Response.json({ status: { code: 0 }, feed_items: [] });
    },
  );
  for (const identity of ["1", "123456", "123456789", "123456789012"])
    await fetchXiaochan(
      testXiaochanAccount({ silkId: identity }),
      {
        label: "南宁",
        cityCode: 450103,
        latitude: 22.82,
        longitude: 108.36,
      },
    );
  assert.ok(nonces.every((nonce) => nonce.length === 16));
  await assert.rejects(fetchXiaochan(testXiaochanAccount({ silkId: "1234567890123" }), {
    label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36,
  }), { statusCode: 401 });
});
test("Xiaochan synchronization requires valid account credentials before querying upstream", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ status: { code: 0 }, feed_items: [] });
  });
  const location = { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
  for (const account of [
    undefined, testXiaochanAccount({ silkId: "0", userId: "0" }),
    testXiaochanAccount({ accessToken: "" }), testXiaochanAccount({ expiresAt: Date.now() - 1 }),
  ]) await assert.rejects(fetchXiaochan(account as XiaochanAccount, location), { statusCode: 401 });
  assert.equal(calls, 0);
});
test("Xiaochan HTTP rejection is not mislabeled as proven risk control and never retried", async (t) => {
  let calls = 0;
  let response: () => Response = () =>
    new Response("Forbidden private-token", { status: 403 });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response();
  });
  const headers = testXiaochanAccount();
  const location = {
    label: "南宁",
    cityCode: 450103,
    latitude: 22.82,
    longitude: 108.36,
  };
  for (const [code, expectedStatus, message] of [
    [403, 502, "小蚕拒绝同步请求"],
    [401, 401, "小蚕登录已失效，请重新登录"],
    [429, 502, "小蚕请求频繁，请稍后重试"],
    [503, 502, "小蚕返回 HTTP 503"],
  ] as const) {
    response = () => new Response("private-token", { status: code });
    await assert.rejects(fetchXiaochan(headers, location), (error: any) => {
      assert.equal(error.statusCode, expectedStatus);
      assert.equal(error.statusMessage, message);
      assert.ok(!JSON.stringify(error).includes("private-token"));
      return true;
    });
  }
  assert.equal(calls, 4);
});
test("Xiaochan identifies only explicit WAF pages without retrying or exposing their contents", async (t) => {
  let response: Response;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response;
  });
  const headers = testXiaochanAccount();
  const location = {
    label: "南宁",
    cityCode: 450103,
    latitude: 22.82,
    longitude: 108.36,
  };
  const genericMessage = "小蚕拒绝同步请求";
  for (const [html, type, message] of [
    [
      "<title>WAF拦截页面</title><p>腾讯云WAF 访问拦截</p><p>private-request-id</p>",
      "text/html; charset=UTF-8",
      "小蚕网关拦截，请检查网络连接",
    ],
    [
      "<title>Forbidden</title><p>private-request-id</p>",
      "text/html",
      genericMessage,
    ],
    [
      "WAF拦截页面 腾讯云WAF private-request-id",
      "application/json",
      genericMessage,
    ],
    ["<title>WAF拦截页面</title>", "text/html", genericMessage],
    ["<p>腾讯云WAF</p>", "text/html", genericMessage],
  ]) {
    response = new Response(html, {
      status: 403,
      headers: { "content-type": type! },
    });
    await assert.rejects(fetchXiaochan(headers, location), (error: any) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.statusMessage, message);
      assert.ok(!JSON.stringify(error).includes("private-request-id"));
      return true;
    });
  }
  assert.equal(calls, 5);
});
test("Xiaochan bounds WAF response inspection and cancels oversized streams", async (t) => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "WAF拦截页面 腾讯云WAF " + "x".repeat(64_000),
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 403, headers: { "content-type": "text/html" } },
  );
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(
    fetchXiaochan(testXiaochanAccount(), {
      label: "南宁",
      cityCode: 450103,
      latitude: 22.82,
      longitude: 108.36,
    }),
    (error: any) => {
      assert.equal(
        error.statusMessage,
        "小蚕拒绝同步请求",
      );
      return true;
    },
  );
  assert.equal(cancelled, true);
});
test("Xiaochan distinguishes expired sessions from RPC failures without exposing upstream fields", async (t) => {
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const headers = testXiaochanAccount();
  const location = {
    label: "南宁",
    cityCode: 450103,
    latitude: 22.82,
    longitude: 108.36,
  };
  for (const [status, expectedStatus, message] of [
    [null, 502, "小蚕返回内容异常，请稍后重试"],
    [{ code: null }, 502, "小蚕返回内容异常，请稍后重试"],
    [{ code: 401, msg: "private-token" }, 401, "小蚕登录已失效，请重新登录"],
    [
      { code: 1001, msg: "登录已失效 private-token" },
      401,
      "小蚕登录已失效，请重新登录",
    ],
    [
      { code: 1002, msg: "invalid X-Nami private-token" },
      502,
      "小蚕请求校验失败，请重新登录",
    ],
    [
      { code: 1003, msg: "upstream unavailable private-token" },
      502,
      "小蚕活动请求失败，请稍后重试",
    ],
    [{ code: 429, msg: "private-token" }, 502, "小蚕请求频繁，请稍后重试"],
  ] as const) {
    payload = { status, secret: "private-token" };
    await assert.rejects(fetchXiaochan(headers, location), (error: any) => {
      assert.equal(error.statusCode, expectedStatus);
      assert.equal(error.statusMessage, message);
      assert.ok(!JSON.stringify(error).includes("private-token"));
      return true;
    });
  }
});
test("browser coordinates convert to GCJ-02 once and remain unchanged outside China", () => {
  const result = toGcj02(39.908823, 116.39747);
  assert.ok(Math.abs(result.latitude - 39.9102265) < 0.000001);
  assert.ok(Math.abs(result.longitude - 116.4037136) < 0.000001);
  assert.deepEqual(toGcj02(37.42159, -122.0837), {
    latitude: 37.42159,
    longitude: -122.0837,
  });
  assert.throws(() => toGcj02(NaN, 108));
  assert.throws(() => toGcj02(91, 108));
});
const geocode = {
  countryCode: "CN",
  city: "南宁",
  locality: "南湖街道",
  localityInfo: {
    administrative: [
      { name: "广西壮族自治区", chinaAdminCode: "450000", order: 2 },
      { name: "南宁市", chinaAdminCode: "450100", order: 3 },
      { name: "青秀区", chinaAdminCode: "450103", order: 4 },
    ],
  },
};
test("automatic address resolves city name and district code without using merchant coordinates", () => {
  const address = addressFromGeocode(geocode, 22.82, 108.36);
  assert.equal(address.cityCode, 450103);
  assert.equal(address.cityName, "南宁市");
  assert.equal(address.label, "南宁市青秀区南湖街道");
  assert.deepEqual(
    { latitude: address.latitude, longitude: address.longitude },
    toGcj02(22.82, 108.36),
  );
  const municipality = addressFromGeocode(
    {
      countryCode: "CN",
      city: "北京市",
      locality: "朝阳区",
      localityInfo: {
        administrative: [
          { name: "北京市", chinaAdminCode: "110000", order: 2 },
          { name: "朝阳区", chinaAdminCode: "110105", order: 3 },
        ],
      },
    },
    39.9,
    116.4,
  );
  assert.equal(municipality.cityName, "北京市");
  assert.equal(municipality.label, "北京市朝阳区");
  for (const input of [
    null,
    {},
    { ...geocode, countryCode: "US" },
    { ...geocode, localityInfo: {} },
  ])
    assert.throws(() => addressFromGeocode(input, 22.82, 108.36));
});
test("Meituan adapter reads user commission, never channel ratio or coupon amounts", () => {
  const result = normalizeMeituan({
    infos: [
      {
        poiId: -100,
        poiBaseInfo: { name: x.name, wm_poi_id: 0 },
        poi_id_str: "opaque",
        planActivityInfoList: [
          {
            poiEventId: "88",
            userMaxRatio: 3500,
            userMaxCommission: 2250,
            ratio: 150,
            maxCommission: 90,
            validInventory: 13,
            planActivityType: "2",
          },
        ],
      },
      {
        poiBaseInfo: { name: "coupon only" },
        giftInfo: { coupon_amount: 2000 },
      },
    ],
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.rule, {
    kind: "percentage",
    thresholdCents: 0,
    ratioBps: 3500,
    capCents: 2250,
  });
  assert.equal(result[0]?.meituanPoiId, undefined);
  assert.throws(() =>
    normalizeMeituan({
      infos: [
        {
          poiBaseInfo: { name: "bad" },
          planActivityInfoList: [
            { poiEventId: "1", ratio: 150, maxCommission: 90 },
          ],
        },
      ],
    }),
  );
});
test("Meituan adapter reads the user review ratio and cap separately from base and channel commissions", () => {
  const plan = {
    poiEventId: "1",
    userMaxRatio: 3500,
    userMaxCommission: 1500,
    unifyToUserCommentRatio: 500,
    unifyToUserCommentCommission: 100,
    ratio: 9999,
    maxCommission: 9999,
  };
  const data = (entry: unknown) => ({
    infos: [
      {
        poiBaseInfo: { name: x.name, distance: "7.0km" },
        planActivityInfoList: [entry],
      },
    ],
  });
  const offer = normalizeMeituan(data(plan))[0]!;
  assert.equal(offer.rule.kind, "percentage");
  assert.deepEqual(offer.reviewBonus, { ratioBps: 500, capCents: 100 });
  assert.equal(offer.distanceMeters, 7000);
  assert.equal(
    normalizeMeituan(
      data({
        ...plan,
        unifyToUserCommentRatio: 0,
        unifyToUserCommentCommission: 0,
      }),
    )[0]?.reviewBonus,
    undefined,
  );
  for (const patch of [
    { unifyToUserCommentRatio: -1 },
    { unifyToUserCommentRatio: 10001 },
    { unifyToUserCommentCommission: -1 },
    { unifyToUserCommentCommission: undefined },
  ])
    assert.throws(() => normalizeMeituan(data({ ...plan, ...patch })));
});
test("previous-day live data is not presented as an active cashback offer", () => {
  assert.equal(
    activeAt(
      { ...x, source: "live", collectedAt: "2026-11-03T01:00:00Z" },
      now,
    ),
    false,
  );
  assert.equal(
    activeAt({ ...x, source: "live", collectedAt: now.toISOString() }, now),
    true,
  );
});
