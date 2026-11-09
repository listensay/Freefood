import { beginLoggedRequest } from "./runtime-logs";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomInt,
  type KeyObject,
} from "node:crypto";
import { createError } from "h3";
import type { AccountProfile, LocationSettings, Offer, SyncScope } from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";
import { toCents } from "../../shared/utils/pricing";
import { collectActivityPages, type ActivityPage } from "./activity-pages";

const CONFIG_URL =
  "https://fz-gateway.waimaimingtang.com/api/api/v2/index/newServiceConfig";
const SHOP_URL =
  "https://wmapp-api-v2.waimaimingtang.com/api/bwc/waimaimt-web-bwc/shopIndex/getShopList";
const USER_URL =
  "https://fz-gateway.waimaimingtang.com/api/api/v2/user/api_user_info_one";
const LEGACY_KEY = "jnd674751fh6fkgu";
const SIGN_KEY = "asdf545asdf4545d";

export interface WaimaiAccount {
  userId: string;
  uid: string;
  token: string;
}

export function assertWaimaiAccount(account: WaimaiAccount) {
  if (!account || typeof account.userId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(account.userId) ||
    typeof account.uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(account.uid) ||
    typeof account.token !== "string" || account.token.length > 16_000 ||
    !/^[A-Za-z0-9._~+/=-]+$/.test(account.token))
    throw createError({ statusCode: 401, statusMessage: "请先登录歪麦" });
}

function encrypt(text: string, key: string): string {
  const cipher = createCipheriv(
    `aes-${Buffer.byteLength(key) * 8}-ecb`,
    Buffer.from(key),
    null,
  );
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

function decrypt(text: string, key: string): string {
  const decipher = createDecipheriv(
    `aes-${Buffer.byteLength(key) * 8}-ecb`,
    Buffer.from(key),
    null,
  );
  return Buffer.concat([
    decipher.update(Buffer.from(text, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function commonHeaders(token: string, city: string): Record<string, string> {
  const nonce = Array.from({ length: 16 }, () => randomInt(9)).join("");
  const timestamp = String(Date.now());
  return {
    application: "overbear_one",
    token,
    nonce,
    timestamp,
    sign: encrypt(timestamp + nonce, SIGN_KEY),
    city: encodeURIComponent(city),
    appversion: "1.1.175",
    referer: "https://servicewechat.com/wx5762f23d920ad9e5/363/page-frame.html",
    "content-type": "application/json",
  };
}

function responseKey(encrypted: string, keyObject: KeyObject): string {
  // Node disables legacy PKCS#1 v1.5 private decryption; validate its block after the RSA operation.
  const block = privateDecrypt(
    { key: keyObject, padding: constants.RSA_NO_PADDING },
    Buffer.from(encrypted, "base64"),
  );
  const separator = block.indexOf(0, 2);
  if (block[0] !== 0 || block[1] !== 2 || separator < 10)
    throw new Error("Invalid response key padding");
  const base64 = block.subarray(separator + 1).toString("ascii");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new Error("Invalid response key");
  const key = Buffer.from(base64, "base64");
  if (
    ![16, 24, 32].includes(key.length) ||
    !/^[A-Za-z0-9]+$/.test(key.toString("ascii"))
  )
    throw new Error("Invalid AES key");
  return key.toString("ascii");
}

const responseLogs = new WeakMap<Response, ReturnType<typeof beginLoggedRequest>>();

async function request(
  url: string,
  init: RequestInit,
  transport: typeof fetch,
) {
  const log = beginLoggedRequest({ provider: "waimai", endpoint: url, method: "POST", client: "mini", clientVersion: "1.1.175" });
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    log.end(error);
    throw createError({
      statusCode: 502,
      statusMessage: "歪麦连接超时或网络异常，请稍后重试",
      data: { waimaiOutcome: "unknown" },
    });
  }
  log.response(response.status, response.headers.get("content-type"), response.headers.get("retry-after"));
  if (!response.ok) {
    const error = createError({
      statusCode: response.status === 401 ? 401 : 502,
      data: { waimaiOutcome: [401, 403, 429].includes(response.status) ? "rejected" : "unknown" },
      statusMessage:
        response.status === 401
          ? "歪麦登录已失效，请重新连接"
          : response.status === 403
            ? "歪麦请求被拦截，请稍后重试"
            : `歪麦返回 HTTP ${response.status}`,
    });
    log.end(error);
    throw error;
  }
  responseLogs.set(response, log);
  return response;
}

function checkStatus(data: any, expected: number | number[]) {
  const valid = ["number", "string"].includes(typeof data?.code) && /^-?\d+$/.test(String(data.code)) &&
    Number.isSafeInteger(Number(data.code));
  const code = valid ? Number(data.code) : undefined;
  if (code !== undefined && (Array.isArray(expected) ? expected : [expected]).includes(code)) return;
  if (code !== undefined && [13001, 13002].includes(code))
    throw createError({ statusCode: 422, statusMessage: "请在电脑微信的歪麦小程序中完成验证后重试", data: { waimaiOutcome: "rejected" } });
  if (code !== undefined && [-3, 401, 403].includes(code))
    throw createError({
      statusCode: 401,
      statusMessage: "歪麦登录已失效，请重新连接",
      data: { waimaiOutcome: "rejected" },
    });
  throw createError({
    statusCode: 502,
    statusMessage: "歪麦接口拒绝访问，请稍后重试",
    data: { waimaiOutcome: code !== undefined && [-1, 400, 429].includes(code) ? "rejected" : "unknown" },
  });
}

export async function verifyWaimaiAccount(
  account: WaimaiAccount,
  transport: typeof fetch = fetch,
): Promise<AccountProfile> {
  assertWaimaiAccount(account);
  const response = await request(USER_URL, {
    headers: commonHeaders(account.token, ""),
    body: JSON.stringify({ json: encrypt(JSON.stringify({
      serviceNoStr: "api_user_info_one", city: "", userId: account.userId,
    }), LEGACY_KEY) }),
  }, transport);
  try {
    const outer = await response.json();
    responseLogs.get(response)?.business(outer?.code);
    if (Number(outer?.code) !== 200) checkStatus(outer, 1);
    const user = typeof outer.data === "string"
      ? JSON.parse(decrypt(outer.data, LEGACY_KEY)) : outer.data;
    if (!user || typeof user !== "object" || Array.isArray(user) ||
      user.uid !== account.uid ||
      (user.application !== undefined && user.application !== "overbear_one"))
      throw createError({ statusCode: 401, statusMessage: "歪麦账号验证失败，请重新连接" });
    const nickname = typeof user.nickName === "string" && user.nickName.trim().length <= 100 &&
      !/[\u0000-\u001f\u007f]/.test(user.nickName) ? user.nickName.trim() : undefined;
    const phone = typeof user.phoneNumber === "string" && /^1[3-9]\d{9}$/.test(user.phoneNumber)
      ? `${user.phoneNumber.slice(0, 3)}****${user.phoneNumber.slice(-4)}`
      : typeof user.phoneNumber === "string" && /^1[3-9]\d\*{4}\d{4}$/.test(user.phoneNumber)
        ? user.phoneNumber : undefined;
    const avatar = safeUrl(user.avatarUrl);
    return { userId: account.uid,
      ...(nickname ? { nickname } : {}), ...(avatar ? { avatar } : {}), ...(phone ? { phone } : {}),
    };
  } catch (error: any) {
    responseLogs.get(response)?.end(error);
    if (error.statusCode) throw error;
    throw createError({ statusCode: 502, statusMessage: "歪麦用户信息无法解析，请稍后重试" });
  } finally { responseLogs.get(response)?.end(); }
}

const requirements: Record<string, string> = {
  overbear_food_no_evaluate: "无需评价",
  return_money_food: "无需评价",
  overbear_food_evaluate: "品鉴意见",
  overbear_food_picture_evaluate: "图文品鉴意见",
  overbear_food_star_picture: "星级带图评价",
  overbear_food_star_word: "星级文字评价",
  overbear_food_word_picture: "图文评价",
};

function timeRange(value: unknown): { startTime?: string; endTime?: string } {
  if (value === undefined || value === null || value === "") return {};
  if (
    typeof value !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(
      value,
    )
  )
    throw new Error("歪麦活动时段格式发生变化");
  return {
    startTime: value.slice(0, 5),
    endTime: value.slice(9) === "23:59:59" ? "24:00" : value.slice(9, 14),
  };
}

export function normalizeWaimai(response: any): Offer[] {
  const rows = response?.data?.data;
  if (!Array.isArray(rows)) throw new Error("歪麦活动列表结构发生变化");
  const collectedAt = new Date().toISOString();
  const offers: Offer[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // Percentage Meituan bounty is an affiliate plan, not an additional Bawangcan rebate.
    if (![1, 3].includes(Number(row.shopPlatformType))) continue;
    if (!row.shopName || !row.id || !Array.isArray(row.overbearfoodList))
      throw new Error("歪麦活动缺少门店或返现规则");
    for (const sku of row.overbearfoodList) {
      if (sku.takeawayPlatform !== "meituan") continue;
      if (!sku.id || !sku.maxGradeRebate)
        throw new Error("歪麦活动缺少返现规则");
      const thresholdCents = toCents(sku.maxGradeRebate.fullMoney);
      const rebate = toCents(sku.maxGradeRebate.rebateMoney);
      const vip = toCents(sku.vipCompensationMoney ?? 0);
      if (vip > rebate) throw new Error("歪麦普通用户返现金额异常");
      const inventory =
        sku.surplusNumber == null ? undefined : Number(sku.surplusNumber);
      if (
        inventory !== undefined &&
        (!Number.isSafeInteger(inventory) || inventory < 0)
      )
        throw new Error("歪麦活动名额格式发生变化");
      const activityId = [sku.overbearFoodId, sku.overbearfoodId, sku.overbearFoodEntityId,
        sku.overbearfoodEntityId, sku.buyOverbearFoodId, sku.buyOverbearfoodId,
        sku.packageId, sku.packageEntityId, sku.foodId, sku.entityId]
        .find(value => value != null && value !== "") ?? sku.id;
      const id = `waimai:${row.id}:${activityId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const poi = String(row.wm_poi_id || row.meituanPoiId || "");
      const distance = /^(\d+(?:\.\d+)?)\s*(km|m|公里|米)$/i.exec(
        String(row.distance || ""),
      );
      offers.push({
        id,
        provider: "waimai",
        name: String(row.shopName),
        category: String(row.categoryName || "美食"),
        address:
          typeof row.shopAddress === "string" ? row.shopAddress : undefined,
        image: safeUrl(row.logoAddress),
        meituanPoiId: /^\d+$/.test(poi) && BigInt(poi) > 0 ? poi : undefined,
        distanceMeters: distance
          ? Math.round(
              Number(distance[1]) *
                (/^(km|公里)$/i.test(distance[2]!) ? 1000 : 1),
            )
          : undefined,
        inventory,
        ...timeRange(sku.releaseTimeQuantum),
        requirement: requirements[sku.mealType] || "请查看歪麦活动要求",
        rule: { kind: "fixed", thresholdCents, cashbackCents: rebate - vip },
        collectedAt,
        source: "live",
        enrollmentAvailable: Number(row.shopPlatformType) === 1 &&
          /^[A-Za-z0-9_-]{1,128}$/.test(String(row.id)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(activityId)),
      });
    }
  }
  return offers;
}

async function encryptedService(
  token: string,
  city: string,
  transport: typeof fetch,
) {
  const config = await request(
    CONFIG_URL,
    {
      headers: commonHeaders(token, city),
      body: JSON.stringify({
        json: encrypt(JSON.stringify({ city }), LEGACY_KEY),
      }),
    },
    transport,
  );
  let publicKey: KeyObject, privateKey: KeyObject;
  try {
    const outer = await config.json();
    responseLogs.get(config)?.business(outer?.code);
    checkStatus(outer, 1);
    const keys = JSON.parse(decrypt(outer.data, LEGACY_KEY));
    if (
      typeof keys.publicKey !== "string" ||
      typeof keys.privateKey !== "string"
    )
      throw new Error("Missing keys");
    publicKey = createPublicKey(
      keys.publicKey.startsWith("-----")
        ? keys.publicKey
        : {
            key: Buffer.from(keys.publicKey, "base64"),
            format: "der",
            type: "spki",
          },
    );
    privateKey = createPrivateKey(
      keys.privateKey.startsWith("-----")
        ? keys.privateKey
        : {
            key: Buffer.from(keys.privateKey, "base64"),
            format: "der",
            type: "pkcs8",
          },
    );
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      privateKey.asymmetricKeyType !== "rsa"
    )
      throw new Error("Invalid service key type");
  } catch (error: any) {
    responseLogs.get(config)?.end(error);
    if (error.statusCode) throw error;
    throw createError({
      statusCode: 502,
      statusMessage: "歪麦服务配置无法解析，请稍后重试",
    });
  } finally { responseLogs.get(config)?.end(); }
  const key = randomBytes(24).toString("hex").slice(0, 32);
  const encryptKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(Buffer.from(key).toString("base64")),
  ).toString("base64");
  return async (url: string, body: Record<string, unknown>, successCodes = [200, 0]) => {
    const response = await request(url, {
      headers: { ...commonHeaders(token, city), "encrypt-key": encryptKey },
      body: encrypt(JSON.stringify(body), key),
    }, transport);
    try {
      const text = await response.text();
      const encryptedKey = response.headers.get("encrypt-key");
      const data = JSON.parse(encryptedKey ? decrypt(text, responseKey(encryptedKey, privateKey)) : text);
      responseLogs.get(response)?.business(data?.code);
      checkStatus(data, successCodes);
      return data;
    } catch (error: any) {
      responseLogs.get(response)?.end(error);
      if (error.statusCode) throw error;
      throw createError({ statusCode: 502, statusMessage: "歪麦返回内容异常，请稍后重试" });
    } finally { responseLogs.get(response)?.end(); }
  };
}

export async function prepareWaimaiSignup(account: WaimaiAccount, city: string, transport: typeof fetch = fetch) {
  assertWaimaiAccount(account);
  const send = await encryptedService(account.token, city, transport);
  return (body: Record<string, unknown>) => send(
    "https://wmapp-api-v2.waimaimingtang.com/api/order/waimaimt-web-order/overbear/signup", body, [200, 1],
  );
}

export async function waimaiOrderRequest(
  account: WaimaiAccount,
  city: string,
  service: "api_overbear_orders_list" | "api_overbear_cancel_sign_up",
  body: Record<string, unknown>,
  transport: typeof fetch = fetch,
) {
  assertWaimaiAccount(account);
  const response = await request(
    `https://fz-gateway.waimaimingtang.com/api/api/v2/overbearfood/${service}`,
    {
      headers: commonHeaders(account.token, city),
      body: JSON.stringify({ json: encrypt(JSON.stringify({ ...body, serviceNoStr: service }), LEGACY_KEY) }),
    }, transport,
  );
  try {
    const outer = await response.json();
    responseLogs.get(response)?.business(outer?.code);
    checkStatus(outer, 1);
    return { ...outer, data: typeof outer.data === "string" ? JSON.parse(decrypt(outer.data, LEGACY_KEY)) : outer.data };
  } catch (error: any) {
    responseLogs.get(response)?.end(error);
    if (error.statusCode) throw error;
    throw createError({ statusCode: 502, statusMessage: "歪麦返回内容异常，请稍后重试" });
  } finally { responseLogs.get(response)?.end(); }
}

export async function fetchWaimai(
  account: WaimaiAccount,
  location: LocationSettings,
  transport: typeof fetch = fetch,
  scope?: SyncScope,
): Promise<Offer[]> {
  assertWaimaiAccount(account);
  const token = account.token;
  const city = location.cityName?.trim();
  if (!city)
    throw createError({
      statusCode: 400,
      statusMessage: "请填写收餐地址的城市名称",
    });
  const send = await encryptedService(token, city, transport);
  const params = {
    userLongitude: String(location.longitude),
    userLatitude: String(location.latitude),
    city,
    limit: 15,
    sortWay: "comprehensive",
    categoryId: "",
    shopName: "",
    secKillFlag: 1,
    signUpFlag: 2,
    highRebatesFlag: 0,
    noCommentFlag: 0,
    takeawayPlatform: "meituan",
    userTypes: [1, 2, 3, 4],
    packageType: "",
    scrollPageData: null,
    threeKmFlag: "",
    overbearFoodType: 1,
    overbearFoodTypes: [1],
    overbearListFlag: 1,
    version: 3,
    localCuisine: "",
    brandIdentityFlag: null,
    tabType: "bwc",
  };
  let cursor: unknown = null;
  const fetchPage = async (): Promise<ActivityPage> => {
    try {
      const data = await send(SHOP_URL, { ...params, scrollPageData: cursor });
      const offers = normalizeWaimai(data);
      cursor = data.data.scrollPageData ?? null;
      if (data.data.hasMore === true && cursor === null)
        throw new Error("Missing activity page cursor");
      return {
        offers,
        rowKeys: data.data.data.map((row: any) => String(row.id)),
        hasMore: data.data.data.length > 0 && cursor !== null && data.data.hasMore !== false,
      };
    } catch (error: any) {
      if (error.statusCode) throw error;
      throw createError({
        statusCode: 502,
        statusMessage: "歪麦活动无法解析，请稍后重试",
      });
    }
  };
  if (!scope) return (await fetchPage()).offers;
  return collectActivityPages(fetchPage, scope.radiusMeters);
}
