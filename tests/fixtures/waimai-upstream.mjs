import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, constants } from "node:crypto";

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
const enrollmentAttempts = new Map();
const cancelledOrders = new Set();
const advanceCardReads = new Map();
const consumedAdvanceCoupons = new Set();
const waimaiOrders = new Map();
const waimaiDecrypt = (text, key) => {
  const cipher = createDecipheriv(`aes-${Buffer.byteLength(key) * 8}-ecb`, Buffer.from(key), null);
  return Buffer.concat([cipher.update(Buffer.from(text, "base64")), cipher.final()]).toString();
};
const waimaiBody = (init, modern = false) => {
  if (!modern) return JSON.parse(waimaiDecrypt(JSON.parse(String(init.body)).json, "jnd674751fh6fkgu"));
  const block = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_NO_PADDING },
    Buffer.from(new Headers(init.headers).get("encrypt-key"), "base64"));
  const key = Buffer.from(block.subarray(block.indexOf(0, 2) + 1).toString(), "base64").toString();
  return JSON.parse(waimaiDecrypt(init.body, key));
};
const md5 = text => createHash("md5").update(text).digest("hex");
const validSignature = headers => {
  const identity = headers.get("x-teemo") || "0";
  const nonce = headers.get("x-nami") || "";
  const method = `${headers.get("servername")}.${headers.get("methodname")}`.toLowerCase();
  const expectedLength = headers.get("x-platform") === "Android" && identity === "0" ? 17 : 16;
  if (nonce.length !== expectedLength || !/^[a-f0-9]+$/.test(nonce) ||
    headers.get("x-ashe") !== md5(md5(method) + headers.get("x-garen") + nonce)) return false;
  if (headers.get("x-platform") !== "Android") return true;
  if (headers.get("x-app-sr") !== "16" || headers.get("x-annie") !== "XC") return false;
  if (identity === "0") return true;
  const middle = Math.floor((16 - identity.length) / 2);
  return nonce.slice(middle, middle + identity.length) === identity;
};

globalThis.fetch = async (url, init) => {
  const hostname = new URL(String(url)).hostname;
  if (hostname === "fz-gateway.waimaimingtang.com") {
    const pathname = new URL(String(url)).pathname.replace(/\/+/g, "/");
    if (pathname.startsWith("/api/api/v2/overbearfood/")) {
      const token = new Headers(init.headers).get("token"), body = waimaiBody(init);
      if (!token || new Headers(init.headers).get("application") !== "overbear_one") return Response.json({ code: 401 });
      const records = waimaiOrders.get(token) || [];
      if (body.serviceNoStr === "api_overbear_orders_list")
        return Response.json({ code: 1, data: records.slice((body.page - 1) * body.limit, body.page * body.limit), count: records.length });
      if (body.serviceNoStr === "api_overbear_cancel_sign_up") {
        const order = records.find(row => row.buyOverbearfoodId === body.buyOverbearfoodId);
        if (!order || body.status !== "buy_cancelled" || body.type !== "overbear_food" ||
          body.overbearfoodId !== order.overbearfoodId || body.serviceId !== order.serviceId)
          return Response.json({ code: 400 });
        order.status = "buy_cancelled";
        return Response.json({ code: 1 });
      }
      return Response.json({ code: 400 });
    }
    if (pathname === "/api/api/v2/user/api_user_info_one") {
      const headers = new Headers(init?.headers), token = headers.get("token");
      const legacyKey = Buffer.from("jnd674751fh6fkgu");
      const decrypt = createDecipheriv("aes-128-ecb", legacyKey, null);
      const body = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(JSON.parse(String(init.body)).json, "base64")), decrypt.final()]).toString());
      if (init.method !== "POST" || !token?.startsWith("wechat-waimai-test-") || headers.get("application") !== "overbear_one" ||
        body.serviceNoStr !== "api_user_info_one" || body.city !== "" || typeof body.userId !== "string" ||
        Object.keys(body).length !== 3)
        return Response.json({ code: 400, message: "Invalid Waimai identity request" });
      if (token === "wechat-waimai-test-expired") return Response.json({ code: -3 });
      if (token === "wechat-waimai-test-network-failure") throw new Error("private-waimai-network-error");
      const user = {
        uid: token === "wechat-waimai-test-mismatched-user" ? "323456789012345678"
          : body.userId === "b64c312a1c6b4a74b72668f0cab713ac" ? "223456789012345678" : "123456789012345678",
        ...(token === "wechat-waimai-test-wrong-application" ? { application: "other_app" } : {}),
        nickName: "歪麦测试用户",
        avatarUrl: "https://example.com/waimai-avatar.png", phoneNumber: "13800000000",
        accessToken: "private-waimai-profile-field",
      };
      const encrypt = createCipheriv("aes-128-ecb", legacyKey, null);
      return Response.json({ code: 1, data: Buffer.concat([encrypt.update(JSON.stringify(user)), encrypt.final()]).toString("base64") });
    }
    return Response.json({ code: 1, data: config });
  }
  if (hostname === "wmapp-api-v2.waimaimingtang.com") {
    const token = new Headers(init?.headers).get("token");
    if (!token) return Response.json({ code: 401 });
    if (new URL(String(url)).pathname === "/api/order/waimaimt-web-order/overbear/signup") {
      const body = waimaiBody(init, true);
      if (body.businessId !== "api-store" || !["api-sku", "api-sku-2"].includes(body.overbearfoodId) ||
        body.type !== "overbear_one" || body.orderSourcePage !== "MEAL_DETAIL" ||
        body.serviceNoStr !== "api_overbear_sign_up" || body.buyChannel !== "autonomy" || !body.userId)
        return Response.json({ code: 400 });
      const records = waimaiOrders.get(token) || [];
      if (records.some(row => row.overbearfoodId === body.overbearfoodId && row.status !== "buy_cancelled"))
        return Response.json({ code: 400 });
      const id = `waimai-order-${records.length + 1}`;
      records.push({ buyOverbearfoodId: id, businessId: body.businessId, overbearfoodId: body.overbearfoodId,
        serviceId: "service-1", type: "overbear_food", platform: "meituan", status: "buy_signup" });
      waimaiOrders.set(token, records);
      return Response.json({ code: 200, data: { buyOverbearId: id, payAmount: 0 } });
    }
    if (token === "expired-test-token") return Response.json({ code: 401 });
    if (token === "network-failure-token")
      throw new Error("upstream unavailable");
    if (token === "verification-test-token")
      return Response.json({ code: 13001, data: { antiCrawlerResult: { reqBizType: "private-challenge" } } });
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
    const rpc = headers.get("methodname");
    const native = headers.get("x-platform") === "Android";
    if (headers.get("x-session-id")?.trimStart().startsWith("{"))
      return new Response("Invalid client session header", { status: 403 });
    if (native && (new URL(String(url)).pathname !== "/rpc" || headers.has("version")))
      return Response.json({ status: { code: 400, msg: "Invalid native gateway" } });
    const body = JSON.parse(String(init.body));
    const advanceFixture = /^enroll-advance-(available|expired|empty|used|ordinary)-(\d+)-[a-f0-9]+$/.exec(token || "");
    const advanceOpening = advanceFixture ? Number(advanceFixture[2]) : undefined;
    if (native && !validSignature(headers))
      return Response.json({ status: { code: 400, msg: "Invalid native signature" } });
    if (rpc === "SilkwormCardService.GetUserCardList") {
      const expected = { silk_id: 123456789, status: 0, offset: 0, number: 20, card_types: [1], ...(native ? {} : { app_id: 20 }) };
      if (!advanceFixture || advanceFixture[1] === "ordinary" || headers.get("servername") !== "SilkwormCard" ||
        headers.get("x-vayne") !== "6789" || JSON.stringify(body) !== JSON.stringify(expected))
        return Response.json({ status: { code: 400, msg: "Invalid advance card request" } });
      const reads = (advanceCardReads.get(token) || 0) + 1;
      advanceCardReads.set(token, reads);
      const unavailable = advanceFixture[1] === "empty" || consumedAdvanceCoupons.has(token) ||
        (advanceFixture[1] === "used" && reads > 1);
      return Response.json({ status: { code: 0 }, list: unavailable ? [] : [{
        id: 701, expire_time: Math.floor((advanceFixture[1] === "expired" ? Date.now() - 1000 : advanceOpening + 3600_000) / 1000),
        card: { card_type: 1 },
      }] });
    }
    if (rpc === "SilkwormService.GetClientUserInfo") {
      if (native || new URL(String(url)).pathname !== "/rpc" || !validSignature(headers) ||
        headers.get("servername") !== "Silkworm" || headers.get("x-platform") !== "mini" ||
        headers.get("x-app-sr") !== "20" || headers.get("x-teemo") !== "123456789" || headers.get("x-vayne") !== "6789" ||
        !token?.startsWith("wechat-test-") ||
        JSON.stringify(body) !== JSON.stringify({ silk_id: 123456789, user_id: 6789, app_id: 20 }))
        return Response.json({ status: { code: 400, msg: "Invalid computer WeChat verification request" } });
      if (token === "wechat-test-expired") return Response.json({ status: { code: 401 } });
      if (token === "wechat-test-network-failure") throw new Error("private-WeChat-upstream-error");
      return Response.json({ status: { code: 0 }, user_info: {
        silk_id: token === "wechat-test-mismatched-silk" ? 999 : 123456789,
        user_id: token === "wechat-test-mismatched-user" ? 999 : 6789,
        if_logoff: token === "wechat-test-logoff", phone: "13800000000",
        nickname: "测试用户", avatar: "https://example.com/xiaochan-avatar.png",
        access_token: "private-profile-field",
      } });
    }
    if (rpc === "SilkwormService.GetPromotionOrderList") {
      if (headers.get("servername") !== "Silkworm" || !token || headers.get("x-vayne") !== "6789" ||
        body.silk_id !== 123456789 || !Array.isArray(body.ids) || body.ids.length > 20 ||
        JSON.stringify(body) !== JSON.stringify({ silk_id: 123456789, ids: body.ids, number: 20, ...(native ? {} : { app_id: 20 }) }))
        return Response.json({ status: { code: 400, msg: "Invalid order state lookup" } });
      if (token === "enroll-sync-failure") throw new Error("private-order-state-error");
      if (token === "enroll-sync-expired") return Response.json({ status: { code: 401 } });
      return Response.json({ status: { code: 0 }, order_list: body.ids.map(id => ({
        promotion_order_id: id, store_platform: 1,
        order_status: cancelledOrders.has(`${token}:${id}`) || (token === "enroll-sync-cancel" && id === 9042) ? 4 : 0,
      })) });
    }
    if (rpc === "SilkwormService.CancelPromotionQuota") {
      if (headers.get("servername") !== "Silkworm" || !token || headers.get("x-vayne") !== "6789" ||
        JSON.stringify(body) !== JSON.stringify({ silk_id: 123456789, promotion_order_id: body.promotion_order_id, ...(native ? {} : { app_id: 20 }) }) ||
        ![9042, 9043].includes(body.promotion_order_id))
        return Response.json({ status: { code: 400, msg: "Invalid cancellation request" } });
      if (token === "enroll-cancel-rejected") return Response.json({ status: { code: 70 } });
      if (token === "enroll-cancel-expired") return Response.json({ status: { code: 401 } });
      if (token === "enroll-cancel-failure") throw new Error("private-cancel-network-error");
      cancelledOrders.add(`${token}:${body.promotion_order_id}`);
      if (token === "enroll-cancel-lost") throw new Error("private-cancel-lost-response");
      return Response.json({ status: { code: 0 } });
    }
    if (rpc === "SilkwormService.GrabPromotionQuota") {
      const expected = {
        silk_id: 123456789, promotion_id: body.promotion_id, store_platform: 1,
        if_advance_order: !!advanceFixture && Date.now() < advanceOpening, if_pre_order: false, city_code: 450103,
        longitude: 108.36, latitude: 22.82,
        ...(native ? {} : { app_id: 20 }),
      };
      if (headers.get("servername") !== "Silkworm" || !token ||
        headers.get("x-vayne") !== "6789" || ![42, 43].includes(body.promotion_id) ||
        JSON.stringify(body) !== JSON.stringify(expected))
        return Response.json({ status: { code: 400, msg: "Invalid quota request" } });
      if (body.if_advance_order) {
        if (advanceFixture[1] !== "available" || consumedAdvanceCoupons.has(token) || Date.now() < advanceOpening - 30 * 60_000)
          return Response.json({ status: { code: 70, msg: "No available advance coupon" } });
        consumedAdvanceCoupons.add(token);
      }
      const key = `${token}:${body.promotion_id}`;
      enrollmentAttempts.set(key, (enrollmentAttempts.get(key) || 0) + 1);
      if (enrollmentAttempts.get(key) > 1 && !cancelledOrders.has(`${token}:${body.promotion_id + 9000}`))
        return Response.json({ status: { code: 70, msg: "Duplicate quota request" } });
      cancelledOrders.delete(`${token}:${body.promotion_id + 9000}`);
      if (token === "enroll-network-failure") throw new Error("private-enrollment-network-error");
      if (token === "enroll-http-failure") return new Response("private-upstream-field", { status: 503 });
      if (token === "enroll-missing-order" || token?.startsWith("enroll-lookup")) return Response.json({ status: { code: 0 } });
      if (token === "enroll-rejected") return Response.json({ status: { code: 70, msg: "名额不足" } });
      if (token === "enroll-expired") return Response.json({ status: { code: 401 } });
      return Response.json({ status: { code: 0 }, promotion_order_id: body.promotion_id + 9000 });
    }
    if (rpc === "SilkwormService.GetStorePromotionDetail") {
      if (advanceFixture) {
        const expected = { silk_id: 123456789, promotion_id: body.promotion_id, ...(native ? {} : { app_id: 20 }) };
        if (headers.get("servername") !== "Silkworm" || headers.get("x-vayne") !== "6789" ||
          ![42, 43].includes(body.promotion_id) || JSON.stringify(body) !== JSON.stringify(expected))
          return Response.json({ status: { code: 400, msg: "Invalid advance detail request" } });
        const opening = new Date(advanceOpening + 8 * 3600_000).toISOString();
        return Response.json({ status: { code: 0 }, promotion_detail: {
          promotion_id: body.promotion_id, meituan_status: 1,
          start_time_hour: Number(opening.slice(11, 13)), start_time_minute: Number(opening.slice(14, 16)),
        } });
      }
      if (headers.get("servername") !== "Silkworm" || !token ||
        headers.get("x-vayne") !== "6789" || body.silk_id !== 123456789 ||
        JSON.stringify(body) !== JSON.stringify({ silk_id: 123456789, promotion_id: 42, ...(native ? {} : { app_id: 20 }) }))
        return Response.json({ status: { code: 400, msg: "Invalid quota lookup" } });
      const promotionId = 42;
      if (enrollmentAttempts.get(`${token}:${promotionId}`) !== 1)
        return Response.json({ status: { code: 400, msg: "Quota was submitted more than once" } });
      if (token === "enroll-network-failure") throw new Error("private-lookup-error");
      if (token === "enroll-lookup-expired") return Response.json({ status: { code: 401 } });
      if (!token.startsWith("enroll-lookup")) return Response.json({ status: { code: 0 } });
      return Response.json({ status: { code: 0 }, promotion_detail: {
        promotion_id: token === "enroll-lookup-mismatched" ? 43 : promotionId, meituan_status: 1,
      }, order_list: [{
        store_platform: token === "enroll-lookup-affiliate" ? 2 : 1,
        promotion_order_id: promotionId + 9000, order_status: 0,
      }] });
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
    if (token === "corrected-xiaochan-test-session" || token?.startsWith("enroll-") ||
      token === "wechat-test-success" || token === "wechat-test-slow-sync") {
      if (token === "wechat-test-slow-sync" && body.offset === 0)
        await new Promise(resolve => setTimeout(resolve, 2_000));
      const expectedBody = {
        silk_id: 123456789, lon: 108.36, lat: 22.82, number: 20,
        offset: body.offset, sort: 0, scene: 1, is_show_mt: true, ...(native ? {} : { app_id: 20 }),
      };
      if (JSON.stringify(body) !== JSON.stringify(expectedBody))
        return Response.json({ status: { code: 400, msg: "Invalid feed request body" } });
      if (body.offset > 0) return Response.json({ status: { code: 0 }, feed_items: [] });
      const md5 = text => createHash("md5").update(text).digest("hex");
      const nonce = headers.get("x-nami");
      const method = `${headers.get("servername")}.${headers.get("methodname")}`.toLowerCase();
      if ((!native && (headers.get("xweb_xhr") !== "1" || !/^[a-f0-9]{4}123456789[a-f0-9]{3}$/.test(nonce || ""))) ||
        headers.get("x-ashe") !== md5(md5(method) + headers.get("x-garen") + nonce))
        return new Response("Invalid request signature", { status: 403 });
      const row = {
        source: 1, store_platform: 1, promotion_id: 42,
        store: { name: "测试店（南宁店）" }, order_money: 2000, user_rebate: 1500,
        left_number: 3, start_time_hour: "00:00", end_time_hour: "24:00", distance: 1200,
      };
      return Response.json({ status: { code: 0 }, feed_items: native || token === "wechat-test-success" ? [
        row, { ...row, promotion_id: 43, order_money: 3000, user_rebate: 2500 },
        { ...row, promotion_id: 44, start_timestamp: Math.floor(Date.now() / 1000) + 86400 },
        { ...row, promotion_id: 45, left_number: 0 },
      ] : [{ ...row, promotion_id: "signed-test-offer" }] });
    }
    throw new Error("Unselected Xiaochan platform was queried");
  }
  return realFetch(url, init);
};
