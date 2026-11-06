import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { xiaochanAccountHeaders, xiaochanRequestHeaders, xiaochanRpc } from "../server/utils/xiaochan-rpc";
import { fetchXiaochan } from "../server/utils/xiaochan";

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

test("Xiaochan request signing requires a complete authenticated account", () => {
  for (const account of [
    undefined,
    { silkId: "0", userId: "0", accessToken: "private" },
    { silkId: "123456789", userId: "6789", accessToken: "" },
    { silkId: "123456789", userId: "6789", accessToken: "bad\r\nheader" },
  ]) assert.throws(() => xiaochanAccountHeaders(account as any), { statusCode: 401 });
  assert.throws(() => xiaochanRequestHeaders({}, "Silkworm", "SilkwormService.GetClientUserInfo"), { statusCode: 401 });
});

test("Native request signing preserves the Android endpoint, header contract and centered identity", () => {
  for (const silkId of ["1", "123456789", "123456789012"]) {
    const headers = xiaochanRequestHeaders(xiaochanAccountHeaders({ silkId, userId: "6789", accessToken: "private" }), "SilkwormFusion", "FusionService.FusionGrabPromotionQuota");
    const nonce = headers["x-nami"]!;
    assert.equal(nonce.length, 16);
    assert.equal(nonce.slice(Math.floor((16 - silkId.length) / 2), Math.floor((16 - silkId.length) / 2) + silkId.length), silkId);
    assert.equal(headers["x-ashe"], md5(md5("silkwormfusion.fusionservice.fusiongrabpromotionquota") + headers["x-garen"] + nonce));
    assert.equal(headers["x-platform"], "Android");
    assert.equal(headers["x-app-sr"], "16");
    assert.equal(headers["x-version"], "3.22.2.5");
    assert.equal(headers["user-agent"], "XC;Android;3.22.2;");
  }
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

test("Native feed synchronization follows page cursors without sending mini-program fields", async t => {
  let page = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gw.xiaocantech.com/g/pa");
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
  const offers = await fetchXiaochan({ silkId: "123456789", userId: "6789", accessToken: "private" },
    { label: "测试地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 }, { radiusMeters: 7000 });
  assert.equal(page, 2);
  assert.deepEqual(offers.map(offer => offer.id), ["xiaochan:1", "xiaochan:2"]);
});
