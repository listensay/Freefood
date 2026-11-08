import test from "node:test";
import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium, type Page } from "playwright-core";
import type { DashboardData, Offer } from "../shared/types";

const server = await preview({ configFile: false, logLevel: "silent", build: { outDir: "dist/client" }, preview: { host: "127.0.0.1", port: 0 } });
const address = server.httpServer.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
const storeUrl = "https://images.test/store.png?signature=keep%2Funchanged";
const avatarUrl = "https://images.test/avatar.png";

function dashboard(): DashboardData {
  const offer: Offer = {
    id: "xiaochan:1", provider: "xiaochan", name: "图片测试店", meituanPoiId: "123", category: "美食",
    source: "import", collectedAt: new Date().toISOString(), inventory: 5, distanceMeters: 100,
    requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 }, image: storeUrl,
  };
  return {
    location: { label: "测试地址", cityCode: 310100, cityName: "上海市", latitude: 31.23, longitude: 121.47 },
    connections: {
      xiaochan: { state: "connected", label: "已登录", profile: { userId: "123", nickname: "测试用户", avatar: avatarUrl } },
      waimai: { state: "disconnected", label: "未连接" }, meituan: { state: "connected", label: "已登录" },
    },
    offers: { xiaochan: [offer], waimai: [], meituan: [{ ...offer, id: "meituan:1", provider: "meituan", image: undefined }] },
    updatedAt: {}, enrollmentSchedules: [],
  };
}

async function fixture(run: (page: Page, data: DashboardData, requests: string[], allow: (fn: (url: string, attempt: number) => boolean) => void) => Promise<void>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const data = dashboard(), requests: string[] = [];
  let succeeds = (_url: string, _attempt: number) => true;
  await page.clock.install();
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "images.test") {
      requests.push(url.href);
      if (!succeeds(url.href, requests.filter(value => value === url.href).length)) return route.abort("failed");
      return route.fulfill({ contentType: "image/png", headers: { "cache-control": "no-store" }, body: png });
    }
    if (url.origin === base && url.pathname.startsWith("/api/"))
      return route.fulfill({ json: url.pathname === "/api/sync" ? { data, errors: [], message: "同步完成" } : data });
    if (url.origin === base) return route.continue();
    return route.abort();
  });
  try { await run(page, data, requests, fn => { succeeds = fn; }); }
  finally { await context.close(); }
}
async function loaded(page: Page, selector: string) {
  await page.waitForFunction(selector => {
    const img = document.querySelector<HTMLImageElement>(selector);
    return img?.complete && img.naturalWidth > 0;
  }, selector, { timeout: 3000 });
}
async function failed(page: Page, container: string) {
  await page.locator(`${container} > svg`).waitFor({ timeout: 3000 });
}
async function exhaust(page: Page, requests: string[], url: string) {
  await failed(page, ".store-picture");
  await page.clock.runFor(500);
  await page.waitForFunction(() => !document.querySelector(".store-picture img"), undefined, { timeout: 3000 });
  await page.clock.runFor(1500);
  await failed(page, ".store-picture");
  assert.equal(requests.filter(value => value === url).length, 3);
}

try {
  await test("A transient store-image failure recovers without changing pages or signed URLs", async () => fixture(async (page, _data, requests, allow) => {
    allow((_url, attempt) => attempt > 1);
    await page.goto(base);
    await failed(page, ".store-picture");
    await page.locator(".store-card").evaluate(el => { el.setAttribute("data-same-card", "true"); });
    await page.clock.runFor(500);
    await loaded(page, ".store-picture img");
    assert.deepEqual(requests, [storeUrl, storeUrl]);
    assert.equal(await page.locator(".store-card").getAttribute("data-same-card"), "true");
  }));
  await test("Avatar failures retry without remounting the account page", async () => fixture(async (page, _data, requests, allow) => {
    allow((_url, attempt) => attempt > 1);
    await page.goto(base + "/accounts");
    await failed(page, ".account-avatar");
    await page.clock.runFor(500);
    await loaded(page, ".account-avatar img");
    assert.deepEqual(requests, [avatarUrl, avatarUrl]);
  }));
  await test("Updated image URLs clear previous failures and cancel stale retries", async () => fixture(async (page, data, requests, allow) => {
    allow(url => url !== storeUrl);
    await page.goto(base);
    await failed(page, ".store-picture");
    await page.locator(".store-card").evaluate(el => { el.setAttribute("data-same-card", "true"); });
    const replacement = "https://images.test/new.png";
    data.offers.xiaochan[0]!.image = replacement;
    await page.getByRole("button", { name: "同步活动", exact: true }).click();
    await loaded(page, ".store-picture img");
    await page.clock.runFor(5000);
    assert.equal(await page.locator(".store-card").getAttribute("data-same-card"), "true");
    assert.deepEqual(requests, [storeUrl, replacement]);
  }));
  await test("A failed primary store image falls back to the matching Meituan image", async () => fixture(async (page, data, requests, allow) => {
    const secondary = "https://images.test/meituan.png";
    data.offers.meituan[0]!.image = secondary;
    allow(url => url === secondary);
    await page.goto(base);
    await failed(page, ".store-picture");
    await page.clock.runFor(500);
    await failed(page, ".store-picture");
    await page.clock.runFor(1500);
    await loaded(page, ".store-picture img");
    assert.deepEqual(requests, [storeUrl, storeUrl, storeUrl, secondary]);
  }));
  await test("Permanent failures have bounded retries and identical fallback URLs are deduplicated", async () => fixture(async (page, data, requests, allow) => {
    data.offers.meituan[0]!.image = storeUrl;
    allow(() => false);
    await page.goto(base);
    await exhaust(page, requests, storeUrl);
    await page.clock.runFor(30_000);
    await failed(page, ".store-picture");
    assert.equal(requests.length, 3);
  }));
  await test("Network recovery reloads failed images without a page switch", async () => fixture(async (page, _data, requests, allow) => {
    allow(() => false);
    await page.goto(base);
    await exhaust(page, requests, storeUrl);
    allow(() => true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await loaded(page, ".store-picture img");
    assert.equal(requests.length, 4);
  }));
  await test("Leaving a page cancels its pending image retries", async () => fixture(async (page, data, requests, allow) => {
    data.connections.xiaochan.profile!.avatar = undefined;
    allow(() => false);
    await page.goto(base);
    await failed(page, ".store-picture");
    await page.getByRole("link", { name: "账号管理", exact: true }).click();
    await page.clock.runFor(5000);
    assert.deepEqual(requests, [storeUrl]);
  }));
} finally {
  await browser.close();
  server.httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
