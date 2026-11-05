import { createCipheriv, createHash, generateKeyPairSync } from "node:crypto";

const keys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const cipher = createCipheriv(
  "aes-128-ecb",
  Buffer.from("jnd674751fh6fkgu"),
  null,
);
const config = Buffer.concat([
  cipher.update(
    JSON.stringify({
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
      privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    }),
  ),
  cipher.final(),
]).toString("base64");
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  const hostname = new URL(String(url)).hostname;
  if (hostname === "fz-gateway.waimaimingtang.com")
    return Response.json({ code: 1, data: config });
  if (hostname === "wmapp-api-v2.waimaimingtang.com") {
    const token = new Headers(init?.headers).get("token");
    if (token === "expired-test-token") return Response.json({ code: 401 });
    if (token === "network-failure-token")
      throw new Error("upstream unavailable");
    return Response.json({
      code: 200,
      data: {
        data: [
          {
            id: "api-store",
            shopName: "API 测试（同一分店）",
            distance: "1.2km",
            shopPlatformType: 1,
            overbearfoodList: [
              {
                id: "api-sku",
                takeawayPlatform: "meituan",
                maxGradeRebate: { fullMoney: "25.00", rebateMoney: "22.00" },
                vipCompensationMoney: "2.00",
                surplusNumber: 3,
                mealType: "overbear_food_no_evaluate",
              },
            ],
          },
        ],
      },
    });
  }
  if (hostname === "gw.xiaocantech.com") {
    const headers = new Headers(init?.headers);
    const token = headers.get("x-sivir");
    if (headers.get("x-teemo") === "0" && headers.get("x-vayne") === "0" && !token) {
      const body = JSON.parse(String(init.body));
      const nonce = headers.get("x-nami") || "";
      const md5 = text => createHash("md5").update(text).digest("hex");
      const method = `${headers.get("servername")}.${headers.get("methodname")}`.toLowerCase();
      if (body.silk_id !== 0 || !/^[a-f0-9]{4}0[a-f0-9]{11}$/.test(nonce) ||
        headers.get("x-ashe") !== md5(md5(method) + headers.get("x-garen") + nonce))
        return Response.json({ status: { code: 400, msg: "Invalid guest request" } });
      if (headers.get("x-session-id") === "failed-guest-session")
        return new Response("Unavailable private-upstream-field", { status: 503 });
      return Response.json({ status: { code: 0 }, feed_items: body.offset === 0 ? [{
        source: 1, store_platform: 1, promotion_id: "guest-offer",
        store: { name: "访客测试（南宁店）" }, order_money: 2000, user_rebate: 1500,
        left_number: 3, start_time_hour: "08:00", end_time_hour: "23:59", distance: 1200,
      }] : [] });
    }
    if (token === "waf-xiaochan-test-session")
      return new Response("<title>WAF拦截页面</title><p>腾讯云WAF 访问拦截</p><p>private-upstream-field</p>", {
        status: 403, headers: { "content-type": "text/html; charset=UTF-8" },
      });
    if (token === "blocked-xiaochan-test-session")
      return new Response("Forbidden private-upstream-field", { status: 403 });
    if (token === "expired-xiaochan-test-session")
      return Response.json({ status: { code: 401 } });
    if (token === "failed-xiaochan-test-session")
      return Response.json({ status: { code: 1003, msg: "Unavailable private-upstream-field" } });
    if (token === "corrected-xiaochan-test-session") {
      const body = JSON.parse(String(init.body));
      const expectedBody = {
        silk_id: 123456789, lon: 108.36, lat: 22.82, number: 20,
        offset: body.offset, sort: 0, scene: 1, is_show_mt: true, app_id: 20,
      };
      if (JSON.stringify(body) !== JSON.stringify(expectedBody))
        return Response.json({ status: { code: 400, msg: "Invalid feed request body" } });
      if (body.offset > 0) return Response.json({ status: { code: 0 }, feed_items: [] });
      const md5 = text => createHash("md5").update(text).digest("hex");
      const nonce = headers.get("x-nami");
      const method = `${headers.get("servername")}.${headers.get("methodname")}`.toLowerCase();
      if (headers.get("xweb_xhr") !== "1" || !/^[a-f0-9]{4}123456789[a-f0-9]{3}$/.test(nonce || "") ||
        headers.get("x-ashe") !== md5(md5(method) + headers.get("x-garen") + nonce))
        return new Response("Invalid request signature", { status: 403 });
      return Response.json({ status: { code: 0 }, feed_items: [{
        source: 1, store_platform: 1, promotion_id: "signed-test-offer",
        store: { name: "测试店（南宁店）" }, order_money: 2000, user_rebate: 1500,
        left_number: 3, start_time_hour: "08:00", end_time_hour: "23:59",
        distance: 1200,
      }] });
    }
    throw new Error("Unselected Xiaochan platform was queried");
  }
  return realFetch(url, init);
};
