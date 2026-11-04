import { chromium } from "playwright-core";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "playwright-core";
import { createError } from "h3";
import type { LocationSettings, Offer } from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";
import { loadSession, saveSession, withSessionLock } from "./session";

export const MEITUAN_URL =
  "https://offsiteact.meituan.com/web/hoae/collection_waimai_v8/index.html?recallBizId=cpsH5Coupon&bizId=224ac1afd8674632ae7b85226f192d82&mediumSrc1=224ac1afd8674632ae7b85226f192d82&scene=CPS_SELF_SRC&pageSrc1=CPS_SELF_OUT_SRC_H5_LINK&pageSrc2=224ac1afd8674632ae7b85226f192d82&pageSrc3=56fa34c7c97c46c8acc60c2b8d7ff7bb&activityId=6&mediaPvId=dafkdsajffjafdfs&mediaUserId=10086&outActivityId=6&hoaePageV=8&p=bcbbb3bf73584d31a709338f189d88c2";

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  headed: boolean;
  lastUsed: number;
  offers: Offer[];
  capturedAt?: string;
  phone: string;
  userChecked: boolean;
  error?: string;
  userError?: string;
  captureAfter: number;
}

const browsers = new Map<string, BrowserSession>();
const launching = new Map<string, Promise<BrowserSession>>();

export function normalizeMeituan(data: any): Offer[] {
  if (!Array.isArray(data.infos)) throw new Error("美团活动列表结构发生变化");
  const offers: Offer[] = [],
    now = new Date().toISOString();
  for (const row of data.infos) {
    const store = row.poiBaseInfo || {};
    if (!store.name) continue;
    // Only user-facing cashback plans count. Coupons and channel commissions are not rebates.
    for (const plan of row.planActivityInfoList || []) {
      const ratio = Number(plan.userMaxRatio),
        cap = Number(plan.userMaxCommission);
      if (
        !Number.isSafeInteger(ratio) ||
        ratio < 0 ||
        ratio > 10000 ||
        !Number.isSafeInteger(cap) ||
        cap < 0 ||
        cap > 100_000_000
      )
        throw new Error("美团用户返现金额字段缺失或发生变化，已停止计算");
      const rawId = String(store.wm_poi_id || "");
      const poiId =
        /^\d+$/.test(rawId) && BigInt(rawId) > 0 ? rawId : undefined;
      const activityId = String(plan.poiEventId || plan.marketingId || "");
      if (!activityId) throw new Error("美团活动缺少唯一 ID");
      const distance = /^(\d+(?:\.\d+)?)\s*(km|m)$/i.exec(store.distance || "");
      offers.push({
        id: `meituan:${row.poi_id_str || poiId || store.name}:${activityId}`,
        provider: "meituan",
        name: store.name,
        category: store.category || "美食",
        address: store.address,
        image: safeUrl(store.picture),
        meituanPoiId: poiId,
        opaquePoiId: row.poi_id_str,
        inventory:
          Number.isInteger(plan.validInventory) && plan.validInventory >= 0
            ? plan.validInventory
            : undefined,
        distanceMeters: distance
          ? Math.round(
              Number(distance[1]) *
                (distance[2]?.toLowerCase() === "km" ? 1000 : 1),
            )
          : undefined,
        requirement:
          String(plan.planActivityType) === "2"
            ? "图文评价 · 按官方任务要求完成"
            : "按官方任务要求完成",
        rule: {
          kind: "percentage",
          thresholdCents: 0,
          ratioBps: ratio,
          capCents: cap,
        },
        url: safeUrl(row.lpUrl),
        collectedAt: now,
        source: "live",
      });
    }
  }
  return offers;
}

function maskPhone(phone: string) {
  return /^\d{11}$/.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : "美团账号";
}

async function applyLocation(
  context: BrowserContext,
  location: LocationSettings,
) {
  await context.setGeolocation({
    latitude: location.latitude,
    longitude: location.longitude,
  });
  await context.addInitScript(({ latitude, longitude }) => {
    const hostname = (
      globalThis as unknown as { location: { hostname: string } }
    ).location.hostname;
    if (hostname.endsWith("meituan.com")) {
      localStorage.setItem(
        "local_storage_key_4_geo",
        JSON.stringify({
          geoInfo: {
            lat: latitude,
            lon: longitude,
            geoType: "GCJ02",
            geoSource: "user",
            geoAccuracy: 50,
          },
          expire: Date.now() + 10 * 60_000,
        }),
      );
    }
  }, location);
}

export async function closeMeituan(id: string) {
  const session = browsers.get(id);
  browsers.delete(id);
  if (session) await session.browser.close().catch(() => {});
}

export async function closeAllMeituan() {
  await Promise.all([...browsers.keys()].map(closeMeituan));
}

async function openBrowser(
  id: string,
  headed: boolean,
): Promise<BrowserSession> {
  const existing = browsers.get(id);
  if (existing?.browser.isConnected() && (!headed || existing.headed)) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (launching.has(id)) return launching.get(id)!;
  const launch = (async () => {
    await closeMeituan(id);
    for (const [key, value] of browsers)
      if (Date.now() - value.lastUsed > 15 * 60_000) await closeMeituan(key);
    if (browsers.size >= 3)
      throw createError({
        statusCode: 429,
        statusMessage: "登录窗口过多，请关闭不用的会话",
      });
    const local = await loadSession(id);
    let browser: Browser;
    try {
      browser = await chromium.launch({
        channel: process.env.FOOD_BROWSER_PATH ? undefined : "chrome",
        executablePath: process.env.FOOD_BROWSER_PATH || undefined,
        headless: !headed,
      });
    } catch {
      throw createError({
        statusCode: 503,
        statusMessage:
          "无法打开登录窗口，请检查 Google Chrome 配置",
      });
    }
    try {
      const context = await browser.newContext({
        viewport: { width: 480, height: 850 },
        permissions: ["geolocation"],
        storageState:
          local.meituanStorage as BrowserContextOptions["storageState"],
      });
      if (local.location) await applyLocation(context, local.location);
      const page = await context.newPage();
      const state: BrowserSession = {
        browser,
        context,
        page,
        headed,
        lastUsed: Date.now(),
        offers: [],
        phone: "",
        userChecked: false,
        captureAfter: Date.now(),
      };
      browsers.set(id, state);
      context.on("response", (response) => {
        const url = new URL(response.url());
        if (url.origin !== "https://offsiteact.meituan.com") return;
        if (
          !["/act/ge/getUserInfo", "/act/ge/queryPoiByRecallBiz"].includes(
            url.pathname,
          )
        )
          return;
        const generation = state.captureAfter;
        if (response.request().timing().startTime < generation) return;
        void (async () => {
          if (!response.ok()) {
            const message =
              response.status() === 403
                ? "美团触发安全校验，请在官方窗口完成验证"
                : `美团官方接口返回 HTTP ${response.status()}，请稍后重试`;
            if (url.pathname === "/act/ge/getUserInfo")
              state.userError = message;
            else state.error = message;
            return;
          }
          const data = await response.json();
          if (generation !== state.captureAfter) return;
          if (!response.ok() || Number(data.ret) !== 0) {
            if (url.pathname === "/act/ge/getUserInfo")
              state.userError = "美团身份接口拒绝访问，请完成官方安全验证";
            else
              state.error =
                "美团活动接口拒绝访问，请在官方窗口完成验证后再刷新";
            return;
          }
          if (url.pathname === "/act/ge/getUserInfo") {
            state.phone = String(data.data?.phone || "");
            state.userChecked = true;
          } else {
            let request: any;
            try {
              request = JSON.parse(response.request().postData() || "{}");
            } catch {
              return;
            }
            if (request.recallBizId !== "cpsSelfPromotionOrder") return;
            const offers = normalizeMeituan(data);
            state.offers = offers;
            state.capturedAt = new Date().toISOString();
            state.error = undefined;
          }
        })().catch((error: any) => {
          if (generation !== state.captureAfter) return;
          if (url.pathname === "/act/ge/getUserInfo")
            state.userError = "无法解析美团身份响应，请重新打开官方登录窗口";
          else
            state.error = error.message?.startsWith("美团")
              ? error.message
              : "无法解析美团活动，请检查官方页面或稍后再试";
        });
      });
      await page.goto(MEITUAN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      return state;
    } catch (error) {
      await browser.close();
      browsers.delete(id);
      throw error;
    }
  })();
  launching.set(id, launch);
  try {
    return await launch;
  } finally {
    launching.delete(id);
  }
}

export async function startMeituanLogin(id: string) {
  const state = await openBrowser(id, true);
  await state.page.bringToFront();
  // The site's own component sends SMS and handles CAPTCHA. Never proxy or bypass its risk checks.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const frame of state.page.frames()) {
      const login = frame.getByText("登录", { exact: true }).first();
      if (await login.isVisible().catch(() => false)) {
        await login.click({ timeout: 3000 }).catch(() => {});
        return;
      }
    }
    if (state.phone) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForOfficialData(
  state: BrowserSession,
  timeout = 30_000,
  needsOffers = true,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (state.userChecked && (!needsOffers || state.capturedAt)) return;
    if (state.userError || (needsOffers && state.error))
      throw createError({
        statusCode: 502,
        statusMessage: state.userError || state.error,
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw createError({
    statusCode: 504,
    statusMessage:
      "美团活动加载失败，请检查官方窗口后重试",
  });
}

export async function verifyMeituanLogin(id: string) {
  const state = await openBrowser(id, false);
  state.userChecked = false;
  state.error = undefined;
  state.userError = undefined;
  state.captureAfter = Date.now();
  state.capturedAt = undefined;
  await state.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForOfficialData(state, 30_000, false);
  await withSessionLock(id, async () => {
    const local = await loadSession(id);
    if (!state.phone) {
      local.connections.meituan = {
        state: "expired",
        label: "未登录",
        message: "请先完成官方登录",
      };
      await saveSession(id, local);
      throw createError({
        statusCode: 401,
        statusMessage: "美团尚未登录，请完成官方登录",
      });
    }
    local.meituanStorage = await state.context.storageState();
    local.connections.meituan = {
      state: "connected",
      label: maskPhone(state.phone),
      updatedAt: new Date().toISOString(),
      message: "登录成功",
    };
    await saveSession(id, local);
  });
}

export async function fetchMeituan(
  id: string,
  location: LocationSettings,
): Promise<Offer[]> {
  const state = await openBrowser(id, false);
  state.lastUsed = Date.now();
  state.userChecked = false;
  state.capturedAt = undefined;
  state.error = undefined;
  state.userError = undefined;
  state.captureAfter = Date.now();
  await applyLocation(state.context, location);
  await state.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForOfficialData(state);
  if (!state.phone)
    throw createError({
      statusCode: 401,
      statusMessage: "美团登录已失效，请重新完成官方登录",
    });
  return state.offers;
}
