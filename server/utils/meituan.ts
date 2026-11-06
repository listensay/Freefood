import { chromium } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
  Frame,
  Request,
} from "playwright-core";
import { createError } from "h3";
import type {
  LocationSettings,
  Offer,
  RemoteLoginSession,
  ReviewBonus,
  SyncScope,
} from "../../shared/types";
import { safeUrl } from "../../shared/utils/import";
import { loadSession, saveSession, withSessionLock } from "./session";
import { isMeituanPage, parseRemoteAction } from "./remote-input";
import {
  activityAccessError,
  MEITUAN_LOGIN_URL,
  passportLoginIdentity,
  passportRequestIssue,
  type PassportIssue,
} from "./meituan-login";
import { MEITUAN_ACTIVITY_URL } from "../../shared/meituan";
import { collectActivityPages, type ActivityPage } from "./activity-pages";
import type { MeituanBrowserStorage } from "./chrome-meituan";

export const MEITUAN_URL = MEITUAN_ACTIVITY_URL;

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
  captureGeneration: number;
  remote?: { token: string; expiresAt: number; verifying: boolean };
  tasks: Promise<unknown>;
  pendingTasks: number;
  pointerDown: boolean;
  passportUserId?: string;
  passportSessionEstablished: boolean;
  pageError?: string;
  offerPages: Map<number, ActivityPage>;
  offerRequest?: { frame: Frame; body: Record<string, unknown>; headers: Record<string, string> };
  loginIssue?: PassportIssue;
}

const browsers = new Map<string, BrowserSession>();
const launching = new Map<string, Promise<BrowserSession>>();
const browserEpochs = new Map<string, number>();
const remoteViewport = { width: 480, height: 680 };

function browserTask<T>(
  state: BrowserSession,
  task: () => Promise<T>,
): Promise<T> {
  if (state.pendingTasks >= 32)
    throw createError({
      statusCode: 429,
      statusMessage: "操作过于频繁，请稍后重试",
    });
  state.pendingTasks++;
  const current = state.tasks.catch(() => {}).then(task);
  state.tasks = current;
  return current.finally(() => {
    state.pendingTasks--;
  });
}

function remoteState(
  id: string,
  token: string,
  allowVerifying = false,
): BrowserSession {
  const state = browsers.get(id);
  if (
    !state?.browser.isConnected() ||
    !state.remote ||
    state.remote.expiresAt <= Date.now()
  )
    throw createError({
      statusCode: 410,
      statusMessage: "登录窗口已关闭，请重新打开",
    });
  if (!/^[a-f0-9]{64}$/.test(token) || state.remote.token !== token)
    throw createError({ statusCode: 403, statusMessage: "登录会话不匹配" });
  if (state.remote.verifying && !allowVerifying)
    throw createError({ statusCode: 409, statusMessage: "正在验证登录" });
  state.lastUsed = Date.now();
  return state;
}

export function isMeituanRemoteActive(id: string, token: string): boolean {
  try {
    remoteState(id, token);
    return true;
  } catch {
    return false;
  }
}

export function hasMeituanBrowser(id: string): boolean {
  return !!browsers.get(id)?.browser.isConnected() || launching.has(id);
}

export function meituanLoginIssue(
  id: string,
  token: string,
): PassportIssue | undefined {
  return remoteState(id, token).loginIssue;
}

function currentPage(state: BrowserSession): Page {
  if (state.page.isClosed()) {
    const page = state.context
      .pages()
      .find((page) => !page.isClosed() && isMeituanPage(page.url()));
    if (!page)
      throw createError({
        statusCode: 410,
        statusMessage: "登录页面已关闭，请重新打开",
      });
    state.page = page;
  }
  return state.page;
}

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
      let reviewBonus: ReviewBonus | undefined;
      if (
        plan.unifyToUserCommentRatio !== undefined ||
        plan.unifyToUserCommentCommission !== undefined
      ) {
        const bonusRatio = Number(plan.unifyToUserCommentRatio);
        const bonusCap = Number(plan.unifyToUserCommentCommission);
        if (
          !Number.isSafeInteger(bonusRatio) ||
          bonusRatio < 0 ||
          bonusRatio > 10_000 ||
          !Number.isSafeInteger(bonusCap) ||
          bonusCap < 0 ||
          bonusCap > 100_000_000
        )
          throw new Error("美团评价加返字段无效，已停止计算");
        if (bonusRatio > 0 && bonusCap > 0)
          reviewBonus = { ratioBps: bonusRatio, capCents: bonusCap };
      }
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
        reviewBonus,
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

async function showPassportForm(page: Page) {
  const switcher = page.getByText("手机动态码登录", { exact: true }).first();
  if (await switcher.isVisible().catch(() => false))
    await switcher.click({ timeout: 3000 });
  const sms = page.locator("#J-mobile-form");
  const normal = page.locator("#J-normal-form");
  const form = (await sms.isVisible().catch(() => false)) ? sms : normal;
  if (await form.isVisible().catch(() => false))
    await form.scrollIntoViewIfNeeded();
}

export async function closeMeituan(id: string) {
  browserEpochs.set(id, (browserEpochs.get(id) || 0) + 1);
  const session = browsers.get(id);
  browsers.delete(id);
  if (session) await session.browser.close().catch(() => {});
}

export async function closeAllMeituan() {
  await Promise.all(
    [...new Set([...browsers.keys(), ...launching.keys()])].map(closeMeituan),
  );
  await Promise.allSettled([...launching.values()]);
}

export async function closeIdleMeituan() {
  const now = Date.now();
  await Promise.all(
    [...browsers]
      .filter(
        ([, state]) =>
          now - state.lastUsed > 15 * 60_000 ||
          (state.remote && state.remote.expiresAt <= now),
      )
      .map(([id]) => closeMeituan(id)),
  );
}

async function openBrowser(
  id: string,
  headed: boolean,
  initialUrl = MEITUAN_URL,
  initialSession?: { meituanStorage: MeituanBrowserStorage; location?: LocationSettings | null },
): Promise<BrowserSession> {
  const existing = browsers.get(id);
  if (existing?.browser.isConnected() && existing.headed === headed) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (launching.has(id)) return launching.get(id)!;
  const launch = (async () => {
    const epoch = (browserEpochs.get(id) || 0) + 1;
    browserEpochs.set(id, epoch);
    browsers.delete(id);
    if (existing) await existing.browser.close().catch(() => {});
    for (const [key, value] of browsers)
      if (Date.now() - value.lastUsed > 15 * 60_000) await closeMeituan(key);
    const pending = [...launching.keys()].filter(
      (key) => key !== id && !browsers.has(key),
    ).length;
    if (browsers.size + pending >= 3)
      throw createError({
        statusCode: 429,
        statusMessage: "登录窗口过多，请关闭不用的会话",
      });
    const local = initialSession || await loadSession(id);
    let browser: Browser;
    try {
      browser = await chromium.launch({
        channel: process.env.FOOD_BROWSER_PATH ? undefined : "chrome",
        executablePath: process.env.FOOD_BROWSER_PATH || undefined,
        headless: !headed,
        // The H5 gateway rejects automation-marked sessions even with valid cookies.
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch {
      throw createError({
        statusCode: 503,
        statusMessage: "无法打开登录页面，请检查服务端 Google Chrome 配置",
      });
    }
    try {
      if (browserEpochs.get(id) !== epoch)
        throw createError({ statusCode: 410, statusMessage: "登录窗口已关闭" });
      const context = await browser.newContext({
        viewport: { width: 480, height: 850 },
        // Keep login verification and synchronization on the same mobile H5 client.
        userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Mobile Safari/537.36`,
        permissions: ["geolocation"],
        storageState:
          local.meituanStorage as BrowserContextOptions["storageState"],
      });
      if (local.location) await applyLocation(context, local.location);
      const page = await context.newPage();
      page.on("download", (download) => {
        void download.cancel().catch(() => {});
      });
      const state: BrowserSession = {
        browser,
        context,
        page,
        headed,
        lastUsed: Date.now(),
        offers: [],
        offerPages: new Map(),
        phone: "",
        userChecked: false,
        captureAfter: Date.now(),
        captureGeneration: 0,
        tasks: Promise.resolve(),
        pendingTasks: 0,
        pointerDown: false,
        passportSessionEstablished: false,
      };
      browsers.set(id, state);
      const requestGenerations = new WeakMap<Request, number>();
      context.on("request", request => {
        requestGenerations.set(request, state.captureGeneration);
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (
          request.isNavigationRequest() &&
          !request.frame().parentFrame() &&
          !isMeituanPage(request.url())
        )
          return route.abort();
        return route.fallback();
      });
      context.on("page", (popup) => {
        popup.on("download", (download) => {
          void download.cancel().catch(() => {});
        });
        void popup
          .waitForURL((url) => isMeituanPage(url.href), {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          })
          .then(async () => {
            if (state.remote) await popup.setViewportSize(remoteViewport);
            state.page = popup;
          })
          .catch(() => popup.close().catch(() => {}));
      });
      context.on("response", (response) => {
        const url = new URL(response.url());
        if (
          url.origin === "https://passport.meituan.com" &&
          [
            "/api/v3/account/mobileloginapply",
            "/api/v3/account/mobilelogin",
            "/account/unitivelogin",
          ].includes(url.pathname) &&
          response.request().method() === "POST"
        ) {
          if (!response.ok()) {
            state.loginIssue = passportRequestIssue(response.status());
            return;
          }
          void response
            .json()
            .then((data) => {
              state.loginIssue = passportRequestIssue(response.status(), data);
              const userId =
                url.pathname === "/api/v3/account/mobileloginapply"
                  ? undefined
                  : passportLoginIdentity(data);
              if (userId) {
                state.passportUserId = userId;
              }
            })
            .catch(() => {
              state.loginIssue = "network";
            });
          return;
        }
        if (
          url.origin === "https://www.meituan.com" &&
          url.pathname === "/account/settoken" &&
          response.request().method() === "POST" &&
          (response.ok() || [301, 302, 303].includes(response.status()))
        ) {
          // This is the official SSO continuation, not a cookie inferred from user input.
          state.passportSessionEstablished = true;
          return;
        }
        if (url.origin !== "https://offsiteact.meituan.com") return;
        if (
          ![
            "/act/ge/getUserInfo",
            "/act/ge/queryPoiByRecallBiz",
            "/act/ge/getPageModuleInfo",
          ].includes(url.pathname)
        )
          return;
        const generation = requestGenerations.get(response.request());
        if (generation !== state.captureGeneration || response.request().timing().startTime < state.captureAfter) return;
        let offerRequest: Record<string, any> | undefined;
        if (url.pathname === "/act/ge/queryPoiByRecallBiz") {
          try {
            offerRequest = JSON.parse(response.request().postData() || "{}");
          } catch { return; }
          if (offerRequest?.recallBizId !== "cpsSelfPromotionOrder") return;
        }
        void (async () => {
          if (!response.ok()) {
            const message = activityAccessError(
              response.status(),
              url.pathname === "/act/ge/getUserInfo"
                ? "identity"
                : url.pathname === "/act/ge/getPageModuleInfo"
                  ? "page"
                  : "offers",
            );
            if (url.pathname === "/act/ge/getUserInfo")
              state.userError = message;
            else if (url.pathname === "/act/ge/getPageModuleInfo")
              state.pageError = message;
            else state.error = message;
            return;
          }
          const data = await response.json();
          if (generation !== state.captureGeneration) return;
          if (!response.ok() || Number(data.ret) !== 0) {
            if (url.pathname === "/act/ge/getUserInfo")
              state.userError = "美团身份接口拒绝访问，请完成官方安全验证";
            else if (url.pathname === "/act/ge/getPageModuleInfo")
              state.pageError = "美团活动页面加载失败，请稍后重试";
            else
              state.error =
                "美团活动接口拒绝访问，请在试吃官页面完成验证后重试";
            return;
          }
          if (url.pathname === "/act/ge/getPageModuleInfo") {
            state.pageError = undefined;
            return;
          }
          if (url.pathname === "/act/ge/getUserInfo") {
            state.phone = String(data.data?.phone || "");
            state.userChecked = true;
            state.userError = undefined;
          } else {
            const request = offerRequest!;
            const offers = normalizeMeituan(data);
            const pageNo = request.pageNo ?? 1;
            if (!Number.isInteger(pageNo) || pageNo < 1) return;
            const requestHeaders = await response.request().allHeaders();
            if (generation !== state.captureGeneration) return;
            state.offerRequest = {
              frame: response.request().frame(),
              body: request,
              headers: Object.fromEntries(Object.entries(requestHeaders).filter(([name]) => name === "content-type")),
            };
            state.offerPages.set(pageNo, {
              offers,
              rowKeys: data.infos.map((row: any) => String(row.poi_id_str || row.poiId || row.poiBaseInfo?.name)),
              hasMore: data.infos.length > 0 && data.hasMore !== false,
            });
            state.offers = [...new Map([...state.offerPages.values()].flatMap(page => page.offers).map(offer => [offer.id, offer])).values()];
            state.capturedAt = new Date().toISOString();
            state.error = undefined;
          }
        })().catch((error: any) => {
          if (generation !== state.captureGeneration) return;
          if (url.pathname === "/act/ge/getUserInfo")
            state.userError = "无法解析美团身份响应，请重新打开试吃官页面";
          else
            state.error = error.message?.startsWith("美团")
              ? error.message
              : "无法解析美团活动，请检查官方页面或稍后再试";
        });
      });
      context.on("requestfailed", (request) => {
        const url = new URL(request.url());
        if (
          url.origin === "https://passport.meituan.com" &&
          [
            "/api/v3/account/mobileloginapply",
            "/api/v3/account/mobilelogin",
            "/account/unitivelogin",
          ].includes(url.pathname) &&
          request.method() === "POST"
        )
          state.loginIssue = "network";
      });
      await page.goto(initialUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (browserEpochs.get(id) !== epoch || browsers.get(id) !== state)
        throw createError({ statusCode: 410, statusMessage: "登录窗口已关闭" });
      return state;
    } catch (error) {
      await browser.close();
      if (browsers.get(id)?.browser === browser) browsers.delete(id);
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

export async function startMeituanLogin(
  id: string,
): Promise<RemoteLoginSession> {
  const state = await openBrowser(id, false, MEITUAN_LOGIN_URL);
  return browserTask(state, async () => {
    const page = currentPage(state);
    await page.setViewportSize(remoteViewport);
    const resume = !!state.remote;
    if (!resume && page.url() !== MEITUAN_LOGIN_URL)
      await page.goto(MEITUAN_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    state.remote = {
      token: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 15 * 60_000,
      verifying: false,
    };
    // Select the official SMS form without sending a code or accepting agreements.
    if (!resume) await showPassportForm(page);
    return {
      token: state.remote.token,
      viewport: remoteViewport,
      expiresAt: new Date(state.remote.expiresAt).toISOString(),
    };
  });
}

export async function captureMeituanFrame(id: string, token: string) {
  const state = remoteState(id, token);
  return browserTask(state, async () => {
    remoteState(id, token);
    const image = await currentPage(state).screenshot({
      type: "jpeg",
      quality: 85,
      timeout: 5000,
    });
    remoteState(id, token);
    return image;
  });
}

export async function inputMeituanRemote(
  id: string,
  token: string,
  input: unknown,
) {
  const state = remoteState(id, token);
  let action;
  try {
    action = parseRemoteAction(input, remoteViewport);
  } catch (error: any) {
    throw createError({ statusCode: 400, statusMessage: error.message });
  }
  return browserTask(state, async () => {
    remoteState(id, token);
    const page = currentPage(state);
    switch (action.type) {
      case "pointer":
        await page.mouse.move(action.x, action.y);
        if (action.phase === "down") {
          if (state.pointerDown) await page.mouse.up();
          await page.mouse.down();
          state.pointerDown = true;
        } else if (action.phase === "up") {
          await page.mouse.up();
          state.pointerDown = false;
        }
        break;
      case "text":
        if (action.text.length <= 64 && /^[\x20-\x7e]+$/.test(action.text))
          await page.keyboard.type(action.text);
        else await page.keyboard.insertText(action.text);
        break;
      case "key":
        await page.keyboard.press(action.key);
        break;
      case "wheel":
        await page.mouse.wheel(action.deltaX, action.deltaY);
        break;
      case "reload":
        state.loginIssue = undefined;
        if (state.pointerDown) {
          await page.mouse.up();
          state.pointerDown = false;
        }
        await page.goto(MEITUAN_LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await showPassportForm(page);
        break;
    }
  });
}

export async function endMeituanRemote(id: string, token: string) {
  remoteState(id, token, true);
  await closeMeituan(id);
}

async function waitForOfficialData(
  state: BrowserSession,
  timeout = 30_000,
  needsOffers = true,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // An expired identity may prevent the official page from requesting offers.
    if (state.userChecked && (!state.phone || !needsOffers || state.capturedAt)) return;
    if (state.userError || state.pageError || (needsOffers && state.error))
      throw createError({
        statusCode: 502,
        statusMessage: state.userError || state.pageError || state.error,
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw createError({
    statusCode: 504,
    statusMessage: needsOffers ? "美团活动加载超时，请稍后重试" : "美团身份验证超时，请稍后重试",
  });
}

export async function verifyMeituanLogin(id: string, token?: string) {
  const state = token ? remoteState(id, token) : await openBrowser(id, false);
  if (state.remote) state.remote.verifying = true;
  let phone: string,
    storage: Awaited<ReturnType<BrowserContext["storageState"]>>,
    accountOnly = false;
  try {
    ({ phone, storage, accountOnly } = await browserTask(state, async () => {
      const passportAuthenticated =
        !!state.passportUserId && state.passportSessionEstablished;
      if (
        !passportAuthenticated &&
        currentPage(state).url().startsWith("https://passport.meituan.com/")
      )
        throw createError({
          statusCode: 401,
          statusMessage: "请先完成美团官方登录",
        });
      const authenticatedStorage = passportAuthenticated
        ? await state.context.storageState()
        : undefined;
      state.userChecked = false;
      state.error = undefined;
      state.userError = undefined;
      state.pageError = undefined;
      state.captureAfter = Date.now();
      state.captureGeneration++;
      state.capturedAt = undefined;
      try {
        await currentPage(state).goto(MEITUAN_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await waitForOfficialData(state, 30_000, false);
      } catch (error) {
        if (!authenticatedStorage) throw error;
        return { phone: "", storage: authenticatedStorage, accountOnly: true };
      }
      if (!state.phone && authenticatedStorage)
        return { phone: "", storage: authenticatedStorage, accountOnly: true };
      return {
        phone: state.phone,
        storage: await state.context.storageState(),
        accountOnly: false,
      };
    }));
  } finally {
    if (state.remote) state.remote.verifying = false;
  }
  await withSessionLock(id, async () => {
    if (browsers.get(id) !== state || !state.browser.isConnected())
      throw createError({ statusCode: 410, statusMessage: "登录窗口已关闭" });
    if (token && state.remote?.token !== token)
      throw createError({
        statusCode: 403,
        statusMessage: "登录会话已更新，请重新打开",
      });
    const local = await loadSession(id);
    if (!phone && !accountOnly) {
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
    local.meituanStorage = storage;
    local.connections.meituan = {
      state: accountOnly ? "configured" : "connected",
      label: maskPhone(phone),
      updatedAt: new Date().toISOString(),
      message: accountOnly ? "账号已登录，活动连接失败" : "登录成功",
    };
    await saveSession(id, local);
  });
  if (token && state.remote?.token === token && browsers.get(id) === state)
    await closeMeituan(id);
}

export async function verifyMeituanBrowserStorage(
  storage: MeituanBrowserStorage,
  location?: LocationSettings | null,
): Promise<{ storage: MeituanBrowserStorage; label: string; accountId: string }> {
  const id = randomBytes(32).toString("hex");
  try {
    const state = await openBrowser(id, false, MEITUAN_URL, { meituanStorage: storage, location });
    await waitForOfficialData(state, 30_000, false);
    if (!state.phone) throw createError({ statusCode: 401, statusMessage: "请先在 Chrome 的试吃官页面中登录" });
    const verifiedStorage = await state.context.storageState();
    return {
      storage: { cookies: verifiedStorage.cookies.filter(cookie =>
        [".meituan.com", "meituan.com", "offsiteact.meituan.com", ".offsiteact.meituan.com"].includes(cookie.domain)), origins: [] },
      label: maskPhone(state.phone),
      accountId: createHash("sha256").update(state.phone).digest("hex"),
    };
  } finally {
    await closeMeituan(id);
  }
}

export async function fetchMeituan(
  id: string,
  location: LocationSettings,
  scope?: SyncScope,
): Promise<Offer[]> {
  // Open a blank context first; the sync navigation below is the only page load.
  const state = await openBrowser(id, false, "about:blank");
  return browserTask(state, async () => {
    state.lastUsed = Date.now();
    await applyLocation(state.context, location);
    for (let attempt = 0; attempt < 2; attempt++) {
      state.phone = "";
      state.userChecked = false;
      state.capturedAt = undefined;
      state.offerPages.clear();
      state.offerRequest = undefined;
      state.offers = [];
      state.error = undefined;
      state.userError = undefined;
      state.pageError = undefined;
      state.captureAfter = Date.now();
      state.captureGeneration++;
      await currentPage(state).goto(MEITUAN_URL, {
        // Official responses below determine readiness, not unrelated page assets.
        waitUntil: "commit",
        timeout: 30_000,
      });
      try {
        await waitForOfficialData(state);
        break;
      } catch (error: any) {
        // Reload once when responses are missing, never on an official refusal.
        if (attempt > 0 || error.statusCode !== 504) throw error;
      }
    }
    if (!state.phone)
      throw createError({
        statusCode: 401,
        statusMessage: "美团登录已失效，请重新完成官方登录",
      });
    if (!scope) return state.offers;
    return collectActivityPages(async (index) => {
      const pageNo = index + 1;
      const captured = state.offerPages.get(pageNo);
      if (captured) return captured;
      const request = state.offerRequest;
      if (
        !request ||
        !request.frame.url().startsWith("https://offsiteact.meituan.com/")
      )
        throw createError({
          statusCode: 502,
          statusMessage: "美团活动分页请求缺失，请重新同步",
        });
      // Sign each new page with the official SDK in the authenticated browser.
      let result;
      try {
        result = await request.frame.evaluate(
          async ({ body, headers, pageNo }) => {
            const url = "/act/ge/queryPoiByRecallBiz";
            const { riskParams, ...payload } = body;
            const data: Record<string, unknown> = { ...payload, pageNo };
            const guard = (globalThis as unknown as {
              H5guard?: {
                sign(request: {
                  url: string;
                  method: string;
                  data: Record<string, unknown>;
                  headers: Record<string, string>;
                }): Promise<{ headers?: Record<string, string> }>;
              };
            }).H5guard;
            if (!guard?.sign) throw new Error("美团活动请求校验未加载");
            let timer: ReturnType<typeof setTimeout> | undefined;
            let signed;
            try {
              signed = await Promise.race([
                guard.sign({ url, method: "POST", data, headers }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("美团活动请求校验超时")), 15_000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            const signature = signed?.headers?.mtgsig;
            if (!signature) throw new Error("美团活动请求校验失败");
            // The official client adds riskParams after signing the request.
            if (riskParams !== undefined) data.riskParams = riskParams;
            const response = await fetch(url, {
              method: "POST",
              credentials: "include",
              redirect: "error",
              headers: { ...headers, mtgsig: signature },
              body: JSON.stringify(data),
              signal: AbortSignal.timeout(15_000),
            });
            return { status: response.status, data: await response.json().catch(() => undefined) };
          },
          { body: request.body, headers: request.headers, pageNo },
        );
      } catch {
        throw createError({
          statusCode: 502,
          statusMessage: "美团活动分页加载失败，请重新同步",
        });
      }
      if (result.status !== 200 || Number(result.data?.ret) !== 0)
        throw createError({
          statusCode: result.status === 401 ? 401 : 502,
          statusMessage: activityAccessError(result.status, "offers"),
        });
      const offers = normalizeMeituan(result.data);
      const page = {
        offers,
        rowKeys: result.data.infos.map((row: any) =>
          String(row.poi_id_str || row.poiId || row.poiBaseInfo?.name),
        ),
        hasMore: result.data.infos.length > 0 && result.data.hasMore !== false,
      };
      state.offerPages.set(pageNo, page);
      state.lastUsed = Date.now();
      return page;
    }, scope.radiusMeters);
  });
}
