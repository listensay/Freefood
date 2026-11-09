import { loggedRequest } from "./runtime-logs";
import { createError } from "h3";
import type { LocationSettings, Offer, SyncScope } from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";
import { collectActivityPages, type ActivityPage } from "./activity-pages";
import { toCents } from "../../shared/utils/pricing";
import { isXiaochanGatewayBlock, xiaochanAccountHeaders, xiaochanRequestHeaders, type XiaochanAccount } from "./xiaochan-rpc";

const endpoint = "https://gw.xiaocantech.com/rpc";

function cents(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 100_000_000)
    throw new Error("小蚕返回了无法识别的金额");
  return n;
}

const positiveId = (value: unknown) =>
  /^\d+$/.test(String(value)) && BigInt(String(value)) > 0
    ? String(value)
    : undefined;

function xiaochanRows(data: any): any[] {
  // The RPC omits empty repeated fields on the final page.
  const rows =
    data.feed_items ??
    data.promotion_list ??
    (data.status &&
    [0, "0"].includes(data.status.code) &&
    Object.keys(data).every((key) => key === "status")
      ? []
      : undefined);
  if (!Array.isArray(rows))
    throw new Error("小蚕接口数据结构发生变化，未识别活动列表");
  return rows;
}

export function normalizeXiaochan(data: any): Offer[] {
  const rows = xiaochanRows(data);
  const now = new Date().toISOString();
  const offers: Offer[] = [];
  for (const row of rows) {
    // Source 5 is Xiaochan's Meituan affiliate commission, not a separate Bawangcan rebate.
    if (row.source !== undefined && Number(row.source) !== 1) continue;
    const old = row.meituan_status !== undefined;
    if (
      old ? Number(row.meituan_status) !== 1 : Number(row.store_platform) !== 1
    )
      continue;
    const store = row.store || {};
    if (!store.name || !row.promotion_id) continue;
    const requiredProduct = row.store_product;
    let product: Offer["product"];
    if (requiredProduct?.name) {
      const discount = requiredProduct.detail?.full_discount_price;
      // Xiaochan uses -1 when the discounted product price is unavailable.
      const price =
        discount == null ||
        String(discount).trim() === "" ||
        Number(discount) === -1
          ? requiredProduct.detail?.sku_price
          : discount;
      product = { name: String(requiredProduct.name) };
      if (price != null && String(price).trim() !== "") {
        try {
          product.priceCents = toCents(price);
        } catch {
          throw new Error("小蚕商品价格异常，请稍后重试");
        }
      }
    }
    // Unavailable product entries have neither a product price nor an order threshold.
    if (
      !old && requiredProduct && row.order_money == null &&
      product?.priceCents === undefined
    )
      continue;
    offers.push({
      id: `xiaochan:${row.promotion_id}`,
      provider: "xiaochan",
      name: String(store.name),
      category: String(store.category_name || "美食"),
      address: store.address,
      image: safeUrl(store.icon),
      meituanPoiId: positiveId(store.wm_poi_id || row.wm_poi_id),
      distanceMeters: Number.isFinite(Number(row.distance))
        ? Number(row.distance)
        : undefined,
      inventory: old ? row.meituan_left_number : row.left_number,
      startTime: formatTime(row.start_time_hour, row.start_time_minute),
      endTime: formatTime(row.end_time_hour, row.end_time_minute),
      validFrom: formatTimestamp(row.start_timestamp),
      validUntil: formatTimestamp(row.end_timestamp),
      requirement:
        Number(row.rebate_condition) === 99
          ? "无需评价"
          : Number(row.rebate_condition) === 2
            ? "图文评价"
            : "请查看小蚕活动要求",
      product,
      rule: {
        kind: "fixed",
        thresholdCents: cents(
          old
            ? row.meituan_order_money
            : (row.order_money ?? (product?.priceCents !== undefined ? 0 : undefined)),
        ),
        cashbackCents: cents(old ? row.meituan_user_rebate : row.user_rebate),
      },
      collectedAt: now,
      source: "live",
      advanceEnrollmentAvailable: !row.if_seckill && !row.is_major && !row.is_brand_promotion &&
        !row.is_brand && Number(row.big_brand_type) !== 4,
    });
  }
  return offers;
}
function formatTime(hour: unknown, minute: unknown): string | undefined {
  if (hour === undefined || hour === null) return undefined;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(String(hour)))
    return String(hour);
  return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

function formatTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799)
    throw new Error("小蚕返回了无法识别的活动有效期");
  return new Date(seconds * 1000).toISOString();
}

async function fetchXiaochanPage(
  headers: Record<string, string>,
  location: LocationSettings,
  offset: number,
  scope?: SyncScope,
  pagePvId?: string,
): Promise<ActivityPage & { nextPvId?: string }> {
  const service = "SilkwormFusion",
    method = "FusionService.GetFeedPromotions";
  const identity = headers["x-teemo"]!;
  const outgoing = {
    ...xiaochanRequestHeaders(headers, service, method, location),
    "x-app-sr": headers["x-platform"] === "Android" ? "16" : "20",
    "x-platform": headers["x-platform"] || "mini",
    ...(headers["x-platform"] === "Android" ? {} : { xweb_xhr: headers.xweb_xhr || "1" }),
    "content-type": "application/json",
  };
  return loggedRequest({ provider: "xiaochan", endpoint, method: "POST", rpc: `${service}.${method}`,
    client: headers["x-platform"] as "mini" | "Android", clientVersion: headers["x-version"] }, async log => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: outgoing,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          silk_id: Number(identity),
          lon: location.longitude,
          lat: location.latitude,
          number: 20,
          offset,
          sort: 0,
          scene: 1,
          is_show_mt: true,
          ...(headers["x-platform"] === "Android" ? {} : { app_id: 20 }),
          ...(pagePvId ? { page_pv_id: pagePvId } : {}),
        }),
      });
    } catch (error) {
      log.failure(error);
      throw createError({
        statusCode: 502,
        statusMessage: "小蚕连接超时或网络异常，请稍后重试",
      });
    }
    log.response(response.status, response.headers.get("content-type"), response.headers.get("retry-after"));
    if (!response.ok) {
      const gatewayBlocked = await isXiaochanGatewayBlock(response);
      throw createError({
        statusCode: response.status === 401 ? 401 : 502,
        statusMessage:
          response.status === 401
            ? "小蚕登录已失效，请重新登录"
            : gatewayBlocked
              ? "小蚕请求被拦截，请稍后重试"
              : response.status === 403
                ? "小蚕拒绝同步请求"
                : response.status === 429
                  ? "小蚕请求频繁，请稍后重试"
                  : `小蚕返回 HTTP ${response.status}`,
      });
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw createError({
        statusCode: 502,
        statusMessage: "小蚕返回内容异常，请稍后重试",
      });
    }
    const status = data?.status;
    log.business(status?.code);
    if (!status || !/^\d+$/.test(String(status.code)))
      throw createError({
        statusCode: 502,
        statusMessage: "小蚕返回内容异常，请稍后重试",
      });
    if (Number(status.code) !== 0) {
      const message = typeof status.msg === "string" ? status.msg : "";
      const expired =
        Number(status.code) === 401 ||
        /未登录|登录(?:已)?(?:过期|失效)|会话(?:已)?(?:过期|失效)|(?:token.{0,8}expired)|unauthenticated|not logged in/i.test(
          message,
        );
      throw createError({
        statusCode: expired ? 401 : 502,
        statusMessage: expired
          ? "小蚕登录已失效，请重新登录"
          : /签名|signature|x-ashe|x-nami/i.test(message)
            ? "小蚕请求校验失败，请重新登录"
            : Number(status.code) === 429
              ? "小蚕请求频繁，请稍后重试"
              : "小蚕活动请求失败，请稍后重试",
      });
    }
    const rows = xiaochanRows(data);
    const offers = normalizeXiaochan({
      feed_items: scope
        ? rows.filter((row) => {
            const distance = Number(row.distance);
            return row.distance != null && Number.isFinite(distance) &&
              distance >= 0 && distance <= scope.radiusMeters;
          })
        : rows,
  });
  return {
    offers,
    rowKeys: rows.map((row: any) => `${row.source}:${row.store_platform}:${row.promotion_id || row.wm_poi_id || row.store_id || row.store?.id || row.name}`),
    hasMore: rows.length > 0 && data.has_more !== false,
    nextPvId: typeof data.next_pv_id === "string" && data.next_pv_id
      ? data.next_pv_id
      : rows.findLast((row: any) => typeof row.page_pv_id === "string" && row.page_pv_id)?.page_pv_id,
  };
  });
}

export async function fetchXiaochan(
  account: XiaochanAccount,
  location: LocationSettings,
  scope?: SyncScope,
): Promise<Offer[]> {
  if (!account || !positiveId(account.silkId) || account.silkId.length > 12 ||
    !Number.isSafeInteger(Number(account.silkId)) || !positiveId(account.userId) ||
    !Number.isSafeInteger(Number(account.userId)) || !account.accessToken ||
    (account.expiresAt !== undefined && account.expiresAt <= Date.now()))
    throw createError({ statusCode: 401, statusMessage: "小蚕登录已失效，请重新登录" });
  const headers = xiaochanAccountHeaders(account);
  if (!scope) return (await fetchXiaochanPage(headers, location, 0)).offers;
  let pagePvId: string | undefined;
  return collectActivityPages(
    async page => {
      const result = await fetchXiaochanPage(headers, location, page * 20, scope, pagePvId);
      pagePvId = result.nextPvId;
      return result;
    },
    scope.radiusMeters,
    { delayMs: 6_000 },
  );
}
