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
import type { LocationSettings, Offer, SyncScope } from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";
import { toCents } from "../../shared/utils/pricing";
import { collectActivityPages, type ActivityPage } from "./activity-pages";

const CONFIG_URL =
  "https://fz-gateway.waimaimingtang.com/api/api/v2/index/newServiceConfig";
const SHOP_URL =
  "https://wmapp-api-v2.waimaimingtang.com/api/bwc/waimaimt-web-bwc/shopIndex/getShopList";
const LEGACY_KEY = "jnd674751fh6fkgu";
const SIGN_KEY = "asdf545asdf4545d";

export function parseWaimaiToken(text: unknown): string {
  if (typeof text !== "string" || text.length > 16_000)
    throw new Error("请提供有效的歪麦登录 token");
  let token = text.trim();
  if (token.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(token);
    } catch {
      throw new Error("请求头 JSON 格式错误");
    }
    const headers = data.headers || data;
    if (!headers || typeof headers !== "object" || Array.isArray(headers))
      throw new Error("请求头 JSON 格式错误");
    const entry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "token",
    );
    if (!entry || typeof entry[1] !== "string")
      throw new Error("请求头缺少歪麦登录 token");
    token = entry[1].trim();
    if (!token) throw new Error("请求头缺少歪麦登录 token");
  }
  if (token && !/^[A-Za-z0-9._~+/=-]+$/.test(token))
    throw new Error("歪麦登录 token 格式错误");
  return token;
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
  const nonce = Array.from({ length: 16 }, () => randomInt(10)).join("");
  const timestamp = String(Date.now());
  return {
    application: "overbear_one",
    ...(token ? { token } : {}),
    nonce,
    timestamp,
    sign: encrypt(timestamp + nonce, SIGN_KEY),
    city: encodeURIComponent(city),
    appversion: "1.1.175",
    referer: "https://servicewechat.com/wx5762f23d920ad9e5/346/page-frame.html",
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

async function request(
  url: string,
  init: RequestInit,
  transport: typeof fetch,
) {
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: "歪麦连接超时或网络异常，请稍后重试",
    });
  }
  if (!response.ok)
    throw createError({
      statusCode: response.status === 401 ? 401 : 502,
      statusMessage:
        response.status === 401
          ? "歪麦登录已失效，请重新导入 token"
          : response.status === 403
            ? "歪麦请求被拦截，请稍后重试"
            : `歪麦返回 HTTP ${response.status}`,
    });
  return response;
}

function checkStatus(data: any, expected: number) {
  if (Number(data?.code) === expected) return;
  if ([401, 403].includes(Number(data?.code)))
    throw createError({
      statusCode: 401,
      statusMessage: "歪麦登录已失效，请重新导入 token",
    });
  throw createError({
    statusCode: 502,
    statusMessage: "歪麦接口拒绝访问，请稍后重试",
  });
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
      const id = `waimai:${row.id}:${sku.id}`;
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
      });
    }
  }
  return offers;
}

export async function fetchWaimai(
  token: string,
  location: LocationSettings,
  transport: typeof fetch = fetch,
  scope?: SyncScope,
): Promise<Offer[]> {
  const city = location.cityName?.trim();
  if (!city)
    throw createError({
      statusCode: 400,
      statusMessage: "请填写收餐地址的城市名称",
    });
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
    if (error.statusCode) throw error;
    throw createError({
      statusCode: 502,
      statusMessage: "歪麦服务配置无法解析，请稍后重试",
    });
  }
  const key = randomBytes(24).toString("hex").slice(0, 32);
  const encryptKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(Buffer.from(key).toString("base64")),
  ).toString("base64");
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
    takeawayPlatform: "",
    userTypes: [1, 2, 3],
    packageType: "",
    scrollPageData: null,
    threeKmFlag: "",
    tabType: "bwc",
  };
  let cursor: unknown = null;
  const fetchPage = async (): Promise<ActivityPage> => {
    const response = await request(
      SHOP_URL,
      {
        headers: { ...commonHeaders(token, city), "encrypt-key": encryptKey },
        body: encrypt(
          JSON.stringify({ ...params, scrollPageData: cursor }),
          key,
        ),
      },
      transport,
    );
    try {
      const text = await response.text();
      const encryptedKey = response.headers.get("encrypt-key");
      const data = JSON.parse(
        encryptedKey
          ? decrypt(text, responseKey(encryptedKey, privateKey))
          : text,
      );
      checkStatus(data, 200);
      const offers = normalizeWaimai(data);
      cursor = data.data.scrollPageData ?? null;
      return {
        offers,
        rowKeys: data.data.data.map((row: any) => String(row.id)),
        hasMore: data.data.data.length > 0 && cursor !== null,
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
