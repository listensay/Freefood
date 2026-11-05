import test from "node:test";
import assert from "node:assert/strict";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";
import {
  fetchWaimai,
  normalizeWaimai,
  parseWaimaiToken,
} from "../server/utils/waimai";
import { calculatePrice, estimatePrice, activeAt } from "../shared/utils/pricing";
import { matchStores } from "../shared/utils/matching";
import { parseOffers } from "../shared/utils/import";
import type { Offer } from "../shared/types";

const sku = {
  id: "sku-1",
  takeawayPlatform: "meituan",
  maxGradeRebate: { fullMoney: "25.00", rebateMoney: "22.50" },
  vipCompensationMoney: "2.50",
  surplusNumber: 5,
  releaseTimeQuantum: "00:00:00-23:59:59",
  mealType: "overbear_food_no_evaluate",
};
const store = {
  id: "internal-123",
  shopName: "好饭（科技园店）",
  shopPlatformType: 1,
  logoAddress: "javascript:alert(1)",
  distance: "1.2km",
  overbearfoodList: [sku],
};
const payload = (rows = [store]) => ({
  code: 200,
  data: { data: rows, scrollPageData: { page: 2 } },
});
const location = {
  label: "科技园",
  cityCode: 440300,
  cityName: "深圳市",
  latitude: 22.54,
  longitude: 113.95,
};

test("Waimai token import accepts a token, case-insensitive JSON headers and explicit guest access", () => {
  assert.equal(parseWaimaiToken(" token-123.abc "), "token-123.abc");
  assert.equal(
    parseWaimaiToken(
      '{"headers":{"Token":"private-token","Host":"evil.example"}}',
    ),
    "private-token",
  );
  assert.equal(parseWaimaiToken(""), "");
  assert.throws(() => parseWaimaiToken('{"authorization":"fake"}'));
  assert.throws(() => parseWaimaiToken('{"token":123}'));
  assert.throws(() => parseWaimaiToken("{bad}"), /请求头 JSON 格式错误/);
  assert.throws(
    () => parseWaimaiToken('{"headers":[]}'),
    /请求头 JSON 格式错误/,
  );
  assert.throws(() => parseWaimaiToken('{"token":""}'));
  assert.throws(() => parseWaimaiToken("a\r\nInjected: 1"));
  assert.throws(() => parseWaimaiToken("$(touch /tmp/should-not-exist)"));
  assert.throws(() => parseWaimaiToken("x".repeat(16_001)));
});

test("Waimai adapter uses yuan accurately and excludes VIP compensation from ordinary cashback", () => {
  const offer = normalizeWaimai(payload())[0]!;
  assert.deepEqual(offer.rule, {
    kind: "fixed",
    thresholdCents: 2500,
    cashbackCents: 2000,
  });
  assert.equal(offer.provider, "waimai");
  assert.equal(offer.id, "waimai:internal-123:sku-1");
  assert.equal(offer.meituanPoiId, undefined);
  assert.equal(offer.image, undefined);
  assert.equal(offer.distanceMeters, 1200);
  assert.equal(offer.inventory, 5);
  assert.equal(offer.requirement, "无需评价");
  assert.equal(offer.endTime, "24:00");
});

test("Waimai adapter preserves distinct SKUs and excludes Eleme, JD and Meituan affiliate bounty", () => {
  const data = payload([
    {
      ...store,
      overbearfoodList: [
        sku,
        { ...sku, id: "sku-2" },
        { ...sku, id: "ele", takeawayPlatform: "ele" },
        { ...sku, id: "jd", takeawayPlatform: "jd" },
      ],
    },
    { ...store, id: "bounty", shopPlatformType: 2 },
    { ...store, id: "fixed-3", shopPlatformType: 3 },
    store,
  ]);
  assert.equal(normalizeWaimai(data).length, 3);
  assert.equal(normalizeWaimai(payload([])).length, 0);
  assert.throws(() => normalizeWaimai({ data: [] }));
  for (const bad of [
    { ...sku, maxGradeRebate: { ...sku.maxGradeRebate, fullMoney: "2.001" } },
    { ...sku, vipCompensationMoney: "100.00" },
    { ...sku, surplusNumber: -1 },
    { ...sku, releaseTimeQuantum: "bad" },
  ])
    assert.throws(() =>
      normalizeWaimai(payload([{ ...store, overbearfoodList: [bad] }])),
    );
});

test("Waimai pairs use the selected provider in matching, calculation and inactive warnings", () => {
  const w = normalizeWaimai(payload())[0]!;
  const m: Offer = {
    ...w,
    provider: "meituan",
    id: "meituan-1",
    rule: {
      kind: "percentage",
      thresholdCents: 0,
      ratioBps: 3500,
      capCents: 1200,
    },
  };
  const match = matchStores([w], [m])[0]!;
  assert.equal(match.confidence, "name");
  assert.equal(match.bawangcan.provider, "waimai");
  const result = calculatePrice({ paidCents: 2500, bawangcan: w, meituan: m });
  assert.equal(result.bawangcanCents, 2000);
  assert.equal(result.waimaiCents, 2000);
  assert.equal(result.xiaochanCents, 0);
  assert.equal(result.meituanCents, 875);
  assert.equal(result.theoreticalNetCents, -375);
  const quote = estimatePrice({
    paidCents: 2500,
    bawangcan: { ...w, inventory: 0 },
    meituan: { ...m, reviewBonus: { ratioBps: 500, capCents: 100 } },
  });
  assert.equal(quote.waimaiCents, 2000);
  assert.equal(quote.meituanCents, 975);
  assert.equal(quote.balanceCents, 475);
  assert.ok(quote.warnings.includes("歪麦活动当前不可用"));
  const unavailable = { ...w, inventory: 0 };
  assert.equal(activeAt(unavailable), false);
  assert.ok(
    calculatePrice({
      paidCents: 2400,
      bawangcan: unavailable,
      meituan: m,
    }).warnings.includes("歪麦活动当前不可用"),
  );
  assert.ok(
    calculatePrice({
      paidCents: 2400,
      bawangcan: w,
      meituan: m,
    }).warnings.includes("未达到歪麦返现门槛"),
  );
  assert.equal(matchStores([m], [m]).length, 0);
  assert.equal(
    parseOffers([{ id: "1", name: w.name, rule: w.rule }], "waimai")[0]
      ?.provider,
    "waimai",
  );
});

const serverKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const clientKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const aes = (text: string, key: string) => {
  const cipher = createCipheriv(
    `aes-${key.length * 8}-ecb`,
    Buffer.from(key),
    null,
  );
  return Buffer.concat([cipher.update(text), cipher.final()]).toString(
    "base64",
  );
};
const unaes = (text: string, key: string) => {
  const decipher = createDecipheriv(
    `aes-${key.length * 8}-ecb`,
    Buffer.from(key),
    null,
  );
  return Buffer.concat([
    decipher.update(Buffer.from(text, "base64")),
    decipher.final(),
  ]).toString();
};
function mockTransport(
  token: string,
  encrypted: boolean,
  result = payload(),
  der = false,
  pages?: unknown[],
): typeof fetch {
  let count = 0;
  return async (url, init) => {
    count++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("token"), token || null);
    assert.equal(headers.get("city"), encodeURIComponent(location.cityName));
    assert.equal(init?.redirect, "error");
    assert.equal(
      unaes(headers.get("sign")!, "asdf545asdf4545d"),
      headers.get("timestamp")! + headers.get("nonce")!,
    );
    if (count === 1) {
      assert.equal(
        String(url),
        "https://fz-gateway.waimaimingtang.com/api/api/v2/index/newServiceConfig",
      );
      assert.deepEqual(
        JSON.parse(
          unaes(JSON.parse(String(init?.body)).json, "jnd674751fh6fkgu"),
        ),
        { city: location.cityName },
      );
      return Response.json({
        code: 1,
        data: aes(
          JSON.stringify({
            publicKey: der
              ? serverKeys.publicKey
                  .export({ type: "spki", format: "der" })
                  .toString("base64")
              : serverKeys.publicKey.export({ type: "spki", format: "pem" }),
            privateKey: der
              ? clientKeys.privateKey
                  .export({ type: "pkcs8", format: "der" })
                  .toString("base64")
              : clientKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
          }),
          "jnd674751fh6fkgu",
        ),
      });
    }
    if (!pages) assert.equal(count, 2, "Only the first page is requested");
    assert.ok(String(url).endsWith("/shopIndex/getShopList"));
    const block = privateDecrypt(
      { key: serverKeys.privateKey, padding: constants.RSA_NO_PADDING },
      Buffer.from(headers.get("encrypt-key")!, "base64"),
    );
    const key = Buffer.from(
      block.subarray(block.indexOf(0, 2) + 1).toString(),
      "base64",
    ).toString();
    const body = JSON.parse(unaes(String(init?.body), key));
    assert.equal(body.city, location.cityName);
    assert.equal(body.userLatitude, String(location.latitude));
    assert.equal(body.userLongitude, String(location.longitude));
    assert.equal(body.limit, 15);
    assert.deepEqual(body.scrollPageData, pages && count > 2
      ? (pages[count - 3] as any).data.scrollPageData : null);
    const current = pages ? pages[count - 2] : result;
    assert.ok(current, "Only available pages are requested");
    if (!encrypted) return Response.json(current);
    const responseAes = "a".repeat(32);
    const encryptedKey = publicEncrypt(
      { key: clientKeys.publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(Buffer.from(responseAes).toString("base64")),
    ).toString("base64");
    return new Response(aes(JSON.stringify(current), responseAes), {
      headers: { "Encrypt-Key": encryptedKey },
    });
  };
}

test("Waimai transport refreshes dynamic keys and handles encrypted authenticated responses", async () => {
  const result = await fetchWaimai(
    "private-token",
    location,
    mockTransport("private-token", true),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.rule.kind, "fixed");
});
test("Waimai transport accepts unencrypted guest responses without assuming login", async () => {
  assert.equal(
    (await fetchWaimai("", location, mockTransport("", false))).length,
    1,
  );
});
test("Waimai transport supports bare base64 DER keys returned by the live service", async () => {
  assert.equal(
    (await fetchWaimai("", location, mockTransport("", true, payload(), true)))
      .length,
    1,
  );
});
test("Waimai radius sync follows encrypted cursors and keeps distinct activity SKUs", async () => {
  const pages = [
    {
      code: 200,
      data: { data: [store], scrollPageData: { page: 2, next: "cursor-2" } },
    },
    {
      code: 200,
      data: {
        data: [
          {
            ...store,
            id: "edge",
            distance: "7.0km",
            overbearfoodList: [
              { ...sku, id: "sku-2" },
              { ...sku, id: "sku-3" },
            ],
          },
          { ...store, id: "far", distance: "7.1km" },
        ],
        scrollPageData: { page: 3, next: "cursor-3" },
      },
    },
    { code: 200, data: { data: [], scrollPageData: null } },
  ];
  const offers = await fetchWaimai(
    "private-token",
    location,
    mockTransport("private-token", true, payload(), false, pages),
    { radiusMeters: 7000 },
  );
  assert.equal(offers.length, 3);
  assert.deepEqual(
    offers.map((offer) => offer.distanceMeters),
    [1200, 7000, 7000],
  );
});
test("Waimai transport rejects missing city, expired login, invalid configuration and network errors", async () => {
  await assert.rejects(
    fetchWaimai("", { ...location, cityName: undefined }, async () => {
      throw new Error("must not fetch");
    }),
    { statusCode: 400 },
  );
  await assert.rejects(
    fetchWaimai("", location, async () => new Response("", { status: 401 })),
    { statusCode: 401 },
  );
  await assert.rejects(
    fetchWaimai("", location, async () => new Response("", { status: 403 })),
    { statusCode: 502 },
  );
  await assert.rejects(
    fetchWaimai("", location, async () =>
      Response.json({ code: 1, data: "bad" }),
    ),
    { statusCode: 502 },
  );
  await assert.rejects(
    fetchWaimai("", location, async () => {
      throw new Error("private upstream message");
    }),
    { statusCode: 502 },
  );
  await assert.rejects(
    fetchWaimai(
      "",
      location,
      mockTransport("", true, { code: 401 } as ReturnType<typeof payload>),
    ),
    { statusCode: 401 },
  );
});
