import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { decodeXiaochanSession, xiaochanAccountHeaders, xiaochanRequestHeaders, xiaochanRpc } from "../server/utils/xiaochan-rpc";
import { fetchXiaochan } from "../server/utils/xiaochan";

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

test("WeChat session cache entries are decoded and expiration is kept separate from account login", () => {
  const now = 1_800_000_000_000;
  const entry = JSON.stringify({ expire: now / 1000 + 1800, value: "cached-session-id" });
  assert.deepEqual(decodeXiaochanSession(entry, undefined, now), {
    sessionId: "cached-session-id", sessionIdExpiresAt: now + 1_800_000,
  });
  assert.equal(decodeXiaochanSession(entry, undefined, now + 1_800_000), undefined);
  assert.equal(decodeXiaochanSession("cached-session-id", now, now), undefined);
  assert.deepEqual(decodeXiaochanSession("legacy-session", undefined, now), { sessionId: "legacy-session" });
  for (const value of ["{bad", JSON.stringify({ expire: "bad", value: "id" }),
    JSON.stringify({ expire: "", value: {} }), JSON.stringify({ expire: "", value: "bad\r\nheader" })])
    assert.equal(decodeXiaochanSession(value, undefined, now), undefined);
});

test("Saved legacy cache envelopes never become request headers and renewed sessions remain stable", t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const account = {
    silkId: "123456789", userId: "6789", accessToken: "session-cache-test", platform: "mini" as const,
    sessionId: JSON.stringify({ expire: now / 1000 + 10, value: "cached-session-id" }),
  };
  const original = structuredClone(account);
  assert.equal(xiaochanAccountHeaders(account)["x-session-id"], "cached-session-id");
  t.mock.timers.tick(10_000);
  const renewed = xiaochanAccountHeaders(account)["x-session-id"]!;
  assert.match(renewed, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(xiaochanAccountHeaders(structuredClone(account))["x-session-id"], renewed);
  assert.notEqual(xiaochanAccountHeaders({ ...account, accessToken: "another-account-session" })["x-session-id"], renewed);
  t.mock.timers.tick(1_800_000);
  assert.notEqual(xiaochanAccountHeaders(account)["x-session-id"], renewed);
  assert.deepEqual(account, original);
});

test("Xiaochan request signing requires a complete authenticated account", () => {
  for (const account of [
    undefined,
    { silkId: "0", userId: "0", accessToken: "private" },
    { silkId: "123456789", userId: "6789", accessToken: "" },
    { silkId: "123456789", userId: "6789", accessToken: "bad\r\nheader" },
  ]) assert.throws(() => xiaochanAccountHeaders(account as any), { statusCode: 401 });
  assert.throws(() => xiaochanRequestHeaders({}, "Silkworm", "SilkwormService.GetClientUserInfo"), { statusCode: 401 });
});

test("Native request signing preserves the Android header contract and centered identity", () => {
  for (const silkId of ["1", "123456789", "123456789012"]) {
    const headers = xiaochanRequestHeaders(xiaochanAccountHeaders({ silkId, userId: "6789", accessToken: "private" }), "SilkwormFusion", "FusionService.FusionGrabPromotionQuota");
    const nonce = headers["x-nami"]!;
    assert.equal(nonce.length, 16);
    assert.equal(nonce.slice(Math.floor((16 - silkId.length) / 2), Math.floor((16 - silkId.length) / 2) + silkId.length), silkId);
    assert.equal(headers["x-ashe"], md5(md5("silkwormfusion.fusionservice.fusiongrabpromotionquota") + headers["x-garen"] + nonce));
    assert.equal(headers["x-platform"], "Android");
    assert.equal(headers["x-app-sr"], "16");
    assert.equal(headers["x-version"], "3.22.2.5");
    assert.equal(headers.version, undefined);
    assert.equal(headers["user-agent"], "XC;Android;3.22.2;");
  }
});

test("Native RPC uses the business endpoint and preserves the supplied App session", async () => {
  const headers = xiaochanAccountHeaders({
    silkId: "123456789", userId: "6789", accessToken: "private",
    platform: "Android", sessionId: "app-session",
  });
  const body = { silk_id: 123456789, user_id: 6789 };
  await xiaochanRpc({
    headers: { ...headers, version: "legacy" },
    serverName: "Silkworm", methodName: "SilkwormService.GetClientUserInfo", body,
  }, (async (url, init) => {
    assert.equal(url, "https://gw.xiaocantech.com/rpc");
    const outgoing = new Headers(init?.headers);
    assert.equal(outgoing.get("x-session-id"), "app-session");
    assert.equal(outgoing.get("x-version"), "3.22.2.5");
    assert.equal(outgoing.has("version"), false);
    assert.equal(outgoing.has("xweb_xhr"), false);
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    assert.equal(init?.redirect, "error");
    return Response.json({ status: { code: 0 } });
  }) as typeof fetch);
});

test("RPC failures classify rejection, official verification and uncertain network outcomes without retries", async () => {
  const request = {
    headers: xiaochanAccountHeaders({ silkId: "123456789", userId: "6789", accessToken: "private" }),
    serverName: "Silkworm", methodName: "SilkwormService.GetClientUserInfo", body: {},
  };
  const cases: Array<[() => Promise<Response>, number, string]> = [
    [async () => Response.json({ status: { code: 401, msg: "private expired field" } }), 401, "rejected"],
    [async () => Response.json({ status: { code: 200001, verify_method: "private" } }), 422, "rejected"],
    [async () => new Response("private failure", { status: 403 }), 502, "rejected"],
    [async () => new Response("private failure", { status: 503 }), 502, "unknown"],
    [async () => new Response("not JSON"), 502, "unknown"],
    [async () => { throw new Error("private network error"); }, 502, "unknown"],
  ];
  for (const [run, status, outcome] of cases) {
    let calls = 0;
    await assert.rejects(xiaochanRpc(request, (async () => { calls++; return run(); }) as typeof fetch), (error: any) =>
      error.statusCode === status && error.data.xiaochanOutcome === outcome && !error.message.includes("private"));
    assert.equal(calls, 1);
  }
});

test("RPC reports confirmed gateway blocks without blaming connectivity or exposing response contents", async () => {
  const request = {
    headers: xiaochanAccountHeaders({ silkId: "123456789", userId: "6789", accessToken: "private" }),
    serverName: "Silkworm", methodName: "SilkwormService.GetClientUserInfo", body: {},
  };
  const html = "<title>WAF拦截页面</title><p>腾讯云 WAF</p><p>private-request-id</p>";
  for (const [status, contentType, body, message, outcome] of [
    [403, "text/html; charset=utf-8", html, "小蚕请求被拦截，请稍后重试", "rejected"],
    [403, "text/html", "<title>Forbidden</title><p>private-request-id</p>", "小蚕请求失败，请稍后重试", "rejected"],
    [403, "application/json", html, "小蚕请求失败，请稍后重试", "rejected"],
    [503, "text/html", html, "小蚕请求失败，请稍后重试", "unknown"],
  ] as const) {
    let calls = 0;
    await assert.rejects(xiaochanRpc(request, (async () => {
      calls++;
      return new Response(body, { status, headers: { "content-type": contentType } });
    }) as typeof fetch), (error: any) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.statusMessage, message);
      assert.equal(error.data.xiaochanOutcome, outcome);
      assert.equal(error.data.xiaochanFailure, status === 403 && contentType.startsWith("text/html") && body === html
        ? "gateway-blocked" : undefined);
      assert.ok(!JSON.stringify(error).includes("private"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Native feed synchronization follows page cursors without sending mini-program fields", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let page = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gw.xiaocantech.com/rpc");
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    assert.equal(headers.has("xweb_xhr"), false);
    assert.equal(body.app_id, undefined);
    assert.equal(body.offset, page * 20);
    assert.equal(body.page_pv_id, page === 0 ? undefined : `page-${page}`);
    page++;
    return Response.json({ status: { code: 0 }, next_pv_id: `page-${page}`, has_more: page < 2,
      feed_items: [{ source: 1, store_platform: 1, promotion_id: page, store: { name: "分页测试店" },
        order_money: 2000, user_rebate: 1500, left_number: 3, distance: 1000 }],
    });
  });
  const pending = fetchXiaochan({ silkId: "123456789", userId: "6789", accessToken: "private" },
    { label: "测试地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 }, { radiusMeters: 7000 });
  assert.equal(page, 1);
  await setImmediate();
  t.mock.timers.tick(5_999);
  await setImmediate();
  assert.equal(page, 1);
  t.mock.timers.tick(1);
  const offers = await pending;
  assert.equal(page, 2);
  assert.deepEqual(offers.map(offer => offer.id), ["xiaochan:1", "xiaochan:2"]);
});

test("Mini-program feed sends each returned page cursor while retaining its platform fields", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let page = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gw.xiaocantech.com/rpc");
    const body = JSON.parse(String(init.body));
    assert.equal(new Headers(init.headers).get("x-platform"), "mini");
    assert.equal(body.app_id, 20);
    assert.equal(body.offset, page * 20);
    assert.equal(body.page_pv_id, [undefined, "next-page", "row-page"][page]);
    page++;
    return Response.json({
      status: { code: 0 }, has_more: page < 3,
      ...(page === 1 ? { next_pv_id: "next-page" } : {}),
      feed_items: [
        { source: 1, store_platform: 1, promotion_id: page, store: { name: "分页测试店" },
          order_money: 2000, user_rebate: 1500, left_number: 3, distance: 1000 },
        { source: 5, wm_poi_id: page, page_pv_id: page === 1 ? "older-page" : "row-page" },
      ],
    });
  });
  const pending = fetchXiaochan({ silkId: "123456789", userId: "6789", accessToken: "private", platform: "mini" },
    { label: "测试地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 }, { radiusMeters: 7000 });
  assert.equal(page, 1);
  for (let expectedPage = 1; expectedPage < 3; expectedPage++) {
    await setImmediate();
    t.mock.timers.tick(5_999);
    await setImmediate();
    assert.equal(page, expectedPage);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(page, expectedPage + 1);
  }
  const offers = await pending;
  assert.equal(page, 3);
  assert.deepEqual(offers.map(offer => offer.id), ["xiaochan:1", "xiaochan:2", "xiaochan:3"]);
});
