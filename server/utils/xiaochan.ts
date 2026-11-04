import { createHash, randomUUID } from "node:crypto";
import { createError } from "h3";
import type { LocationSettings, Offer } from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";

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

export function parseXiaochanSession(text: string): Record<string, string> {
  if (!text || text.length > 64_000)
    throw new Error("请提供本人小蚕请求的 cURL 或请求头 JSON");
  let raw: Record<string, unknown> = {};
  if (text.trim().startsWith("{")) {
    const json = JSON.parse(text);
    raw = json.headers || json;
  } else {
    const words = shellWords(text);
    if (words[0] !== "curl")
      throw new Error("请粘贴有效的小蚕 cURL 请求");
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
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (
      /^x-[a-z0-9-]+$/.test(name) ||
      ["authorization", "cookie", "version", "user-agent", "referer"].includes(
        name,
      )
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
    BigInt(headers["x-teemo"]!) <= 0 ||
    BigInt(headers["x-vayne"]!) <= 0
  )
    throw new Error(
      "会话缺少登录字段，请重新复制小程序请求",
    );
  return headers;
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

export function normalizeXiaochan(data: any): Offer[] {
  const rows = data.feed_items || data.promotion_list;
  if (!Array.isArray(rows))
    throw new Error("小蚕接口数据结构发生变化，未识别活动列表");
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
      requirement:
        Number(row.rebate_condition) === 99
          ? "无需评价"
          : Number(row.rebate_condition) === 2
            ? "图文评价"
            : "请查看小蚕活动要求",
      rule: {
        kind: "fixed",
        thresholdCents: cents(old ? row.meituan_order_money : row.order_money),
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
  return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

export async function fetchXiaochan(
  headers: Record<string, string>,
  location: LocationSettings,
): Promise<Offer[]> {
  const service = "SilkwormFusion",
    method = "FusionService.GetFeedPromotions";
  const timestamp = String(Date.now()),
    identity = headers["x-teemo"]!;
  const uuid = randomUUID().replaceAll("-", "");
  const nami = `${uuid.slice(0, 4)}${identity}${uuid.slice(4, Math.max(4, 20 - identity.length))}`;
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
        lat: location.latitude,
        lon: location.longitude,
        number: 20,
        silk_id: Number(identity),
        sort: 1,
        offset: 0,
        app_id: "20",
        scene: 1,
        is_show_mt: true,
        rebate_type: 1,
        page_pv_id: "",
      }),
    });
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: "小蚕连接超时或网络异常，请稍后重试",
    });
  }
  if (!response.ok)
    throw createError({
      statusCode: response.status === 401 ? 401 : 502,
      statusMessage:
        response.status === 403
          ? "小蚕请求被风控拦截，请暂停刷新后再试"
          : `小蚕返回 HTTP ${response.status}`,
    });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: "小蚕未返回 JSON，可能触发了风控",
    });
  }
  if (!data.status || Number(data.status.code) !== 0)
    throw createError({
      statusCode: 401,
      statusMessage: "小蚕会话无效，请重新导入",
    });
  return normalizeXiaochan(data);
}
