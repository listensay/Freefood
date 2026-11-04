import test from "node:test";
import assert from "node:assert/strict";
import type { Offer } from "../shared/types";
import {
  activeAt,
  calculatePrice,
  rebateFor,
  toCents,
} from "../shared/utils/pricing";
import { matchStores } from "../shared/utils/matching";
import { parseOffers, csvCell } from "../shared/utils/import";
import {
  parseXiaochanSession,
  normalizeXiaochan,
} from "../server/utils/xiaochan";
import { normalizeMeituan } from "../server/utils/meituan";

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
      couponUsed: true,
      sameStoreConfirmed: true,
      stackingConfirmed: true,
    }).warnings,
    ["使用活动页优惠券，美团返现不适用"],
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
test("coupon disables Meituan cashback instead of double-counting discount", () => {
  const r = calculate({ couponUsed: true });
  assert.equal(r.meituanCents, 0);
  assert.equal(r.theoreticalNetCents, 500);
  assert.match(r.warnings.join(" "), /优惠券/);
});
test("percentage cashback applies cap and floors fractional cents", () => {
  assert.equal(rebateFor(m.rule, 5000), 1200);
  assert.equal(rebateFor(m.rule, 101), 35);
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
test("Xiaochan session parses cURL without executing commands or using repository account", () => {
  const curl = `curl 'https://gw.xiaocantech.com/rpc' \\\n-H 'X-Teemo: 123456' -H 'X-Vayne: 6789' -H 'X-Version: 3.21' -H 'Host: evil.example' --data-raw '{"value":"$(touch /tmp/should-not-exist)"}'`;
  const headers = parseXiaochanSession(curl);
  assert.equal(headers["x-teemo"], "123456");
  assert.equal(headers["x-vayne"], "6789");
  assert.equal(headers.host, undefined);
  assert.throws(() =>
    parseXiaochanSession(
      `curl 'https://evil.example/rpc' -H 'X-Teemo: 123' -H 'X-Vayne: 456'`,
    ),
  );
  assert.throws(() => parseXiaochanSession('{"x-teemo":"1"}'));
  assert.throws(() =>
    parseXiaochanSession(
      '{"x-teemo":"1","x-vayne":"2","authorization":"abc\\r\\nInjected: 1"}',
    ),
  );
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
