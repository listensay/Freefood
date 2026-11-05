import { createHash, randomUUID } from "node:crypto";
import { createError } from "h3";
import type { LocationSettings, Offer, SyncScope } from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";
import { collectActivityPages, type ActivityPage } from "./activity-pages";
import { toCents } from "../../shared/utils/pricing";

const endpoint = "https://gw.xiaocantech.com/rpc";
const md5 = (text: string) => createHash("md5").update(text).digest("hex");

function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (
        c === "\\" &&
        quote === '"' &&
        ['"', "\\", "$", "`"].includes(text[i + 1] || "")
      )
        word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\") {
      if (text[i + 1] !== "\n") {
        word += text[++i] || "";
        started = true;
      } else i++;
    } else if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error("cURL 引号不完整");
  if (started) words.push(word);
  return words;
}

export function parseXiaochanSession(input: unknown): Record<string, string> {
  if (typeof input !== "string" || !input.trim() || input.length > 64_000)
    throw new Error("请提供本人小蚕请求的请求头或 cURL");
  const text = input.trim();
  let raw: Record<string, unknown> = {};
  if (text.startsWith("{")) {
    const json = JSON.parse(text);
    raw = json.headers ?? json;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("请求头格式错误");
  } else if (/^curl(?:\s|$)/.test(text)) {
    const words = shellWords(text);
    if (words[0] !== "curl") throw new Error("请粘贴有效的小蚕 cURL 请求");
    const urls = words.filter((w) => /^https?:\/\//.test(w));
    if (
      !urls.some((w) => {
        try {
          const u = new URL(w);
          return (
            u.origin === "https://gw.xiaocantech.com" && u.pathname === "/rpc"
          );
        } catch {
          return false;
        }
      })
    )
      throw new Error("仅接受 gw.xiaocantech.com/rpc 的小蚕请求");
    for (let i = 1; i < words.length; i++) {
      let header: string | undefined;
      if (words[i] === "-H" || words[i] === "--header") header = words[++i];
      else if (words[i]?.startsWith("--header=")) header = words[i]!.slice(9);
      if (header) {
        const colon = header.indexOf(":");
        if (colon > 0)
          raw[header.slice(0, colon)] = header.slice(colon + 1).trim();
      }
    }
  } else {
    if (/^https?:\/\//i.test(text))
      throw new Error("网址不包含登录会话，请复制请求头或 cURL");
    for (const source of text.split(/\r?\n/)) {
      // Captured headers may have Markdown escapes and trailing line breaks.
      const line = source.trim().replace(/\\$/, "").trim();
      if (!line) continue;
      const match = /^(:?[a-zA-Z0-9!#$%&'*+.^_`|~-]+):\s*(.*)$/.exec(line);
      if (!match) throw new Error("请求头格式错误");
      const name = match[1]!.toLowerCase();
      if (Object.hasOwn(raw, name)) throw new Error("请求头不能重复");
      raw[name] = match[2]!;
    }
    for (const name of [":authority", ":path", ":scheme", "referer"]) {
      if (typeof raw[name] === "string")
        raw[name] = raw[name].replace(/\\([.:/])/g, "$1");
    }
    if (
      (raw[":authority"] !== undefined &&
        raw[":authority"] !== "gw.xiaocantech.com") ||
      (raw[":path"] !== undefined && raw[":path"] !== "/rpc") ||
      (raw[":scheme"] !== undefined && raw[":scheme"] !== "https")
    )
      throw new Error("仅接受 gw.xiaocantech.com/rpc 的小蚕请求");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (
      /^x-[a-z0-9-]+$/.test(name) ||
      ["authorization", "cookie", "version", "user-agent", "referer", "xweb_xhr"].includes(name)
    ) {
      if (
        typeof value !== "string" ||
        /[\r\n]/.test(value) ||
        value.length > 16000
      )
        throw new Error("请求头格式错误");
      headers[name] = value;
    }
  }
  if (
    !/^\d+$/.test(headers["x-teemo"] || "") ||
    !/^\d+$/.test(headers["x-vayne"] || "") ||
    headers["x-teemo"]!.length > 12
  )
    throw new Error("会话缺少登录字段，请重新复制小程序请求");
  const guestDevice = /^0+$/.test(headers["x-teemo"]!);
  const guestUser = /^0+$/.test(headers["x-vayne"]!);
  if (guestDevice !== guestUser)
    throw new Error("会话身份字段不完整，请重新复制小程序请求");
  if (guestDevice) {
    headers["x-teemo"] = "0";
    headers["x-vayne"] = "0";
  }
  return headers;
}

export function isXiaochanGuest(headers: Record<string, string>): boolean {
  return headers["x-teemo"] === "0" && headers["x-vayne"] === "0";
}

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

async function isXiaochanGatewayBlock(response: Response): Promise<boolean> {
  if (
    response.status !== 403 ||
    !response.headers.get("content-type")?.toLowerCase().includes("text/html") ||
    !response.body
  )
    return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64_000) return false;
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString("utf8");
    return /WAF拦截页面/.test(html) && /腾讯云\s*WAF/i.test(html);
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchXiaochanPage(
  headers: Record<string, string>,
  location: LocationSettings,
  offset: number,
  scope?: SyncScope,
): Promise<ActivityPage> {
  const service = "SilkwormFusion",
    method = "FusionService.GetFeedPromotions";
  const timestamp = String(Date.now()),
    identity = headers["x-teemo"]!;
  const uuid = randomUUID().replaceAll("-", "");
  // X-Nami is 16 characters: four hex digits, the device ID, then the suffix.
  const nami = `${uuid.slice(0, 4)}${identity}${uuid.slice(4, 16 - identity.length)}`;
  const outgoing = {
    ...headers,
    serverName: service,
    methodName: method,
    version: headers.version || headers["x-version"] || "3.21.7.82",
    "x-version": headers["x-version"] || headers.version || "3.21.7.82",
    "x-nami": nami,
    "x-garen": timestamp,
    "x-ashe": md5(md5(`${service}.${method}`.toLowerCase()) + timestamp + nami),
    "x-city": String(location.cityCode),
    "x-app-sr": "20",
    "x-platform": headers["x-platform"] || "mini",
    xweb_xhr: headers.xweb_xhr || "1",
    "content-type": "application/json",
  };
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
        app_id: 20,
      }),
    });
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: "小蚕连接超时或网络异常，请稍后重试",
    });
  }
  if (!response.ok) {
    const gatewayBlocked = await isXiaochanGatewayBlock(response);
    throw createError({
      statusCode: response.status === 401 ? 401 : 502,
      statusMessage:
        response.status === 401
          ? "小蚕会话无效，请重新导入"
          : gatewayBlocked
            ? "小蚕网关拦截，请检查网络连接"
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
        ? "小蚕会话无效，请重新导入"
        : /签名|signature|x-ashe|x-nami/i.test(message)
          ? "小蚕请求校验失败，请重新导入会话"
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
  };
}

export async function fetchXiaochan(
  headers: Record<string, string>,
  location: LocationSettings,
  scope?: SyncScope,
): Promise<Offer[]> {
  if (!scope) return (await fetchXiaochanPage(headers, location, 0)).offers;
  return collectActivityPages(
    page => fetchXiaochanPage(headers, location, page * 20, scope),
    scope.radiusMeters,
  );
}
