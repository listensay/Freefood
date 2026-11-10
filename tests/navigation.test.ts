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
const offer: Offer = {
  id: "xiaochan:1", provider: "xiaochan", name: "切换测试店", meituanPoiId: "123", category: "美食",
  source: "import", collectedAt: new Date().toISOString(), inventory: 5, distanceMeters: 100,
  requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
};
const data: DashboardData = {
  location: { label: "测试地址", cityCode: 310100, cityName: "上海市", latitude: 31.23, longitude: 121.47 },
  connections: {
    xiaochan: { state: "disconnected", label: "未连接" }, waimai: { state: "disconnected", label: "未连接" },
    meituan: { state: "disconnected", label: "未连接" },
  },
  offers: { xiaochan: [offer], waimai: [], meituan: [{ ...offer, id: "meituan:1", provider: "meituan" }] },
  updatedAt: {}, enrollmentSchedules: [],
};
type MotionSample = { classes: string; duration: string; opacity: string; transform: string; pageCount: number };

async function fixture(run: (page: Page, requests: string[]) => Promise<void>, options: { reducedMotion?: boolean; desktop?: boolean } = {}) {
  const context = await browser.newContext({
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
    viewport: options.reducedMotion ? { width: 390, height: 844 } : { width: 1280, height: 820 },
  });
  const page = await context.newPage();
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "warning" || message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(({ desktop, data }) => {
    const state = window as any;
    state.pageMotionSamples = [];
    state.dashboardLoads = 0;
    if (desktop) {
      state.isTauri = true;
      state.__TAURI_INTERNALS__ = { async invoke(command: string, args: { path: string }) {
        if (command !== "api_request" || args.path !== "/api/dashboard") throw new Error("Unexpected native call");
        state.dashboardLoads++;
        return { status: 200, body: JSON.stringify(data) };
      } };
    }
    new MutationObserver(records => {
      for (const record of records) {
        const element = record.target;
        if (!(element instanceof HTMLElement) || !element.isConnected || !/page-(enter|leave)-/.test(element.className)) continue;
        const style = getComputedStyle(element);
        state.pageMotionSamples.push({ classes: element.className, duration: style.transitionDuration,
          opacity: style.opacity, transform: style.transform, pageCount: document.querySelectorAll(".main-content > :not(.notice)").length });
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
  }, { desktop: !!options.desktop, data });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname);
    if (url.pathname === "/api/dashboard") {
      return route.fulfill({ json: data });
    }
    if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected API request: ${url.pathname}`);
    return route.continue();
  });
  try { await run(page, requests); assert.deepEqual(errors, []); }
  finally { await context.close(); }
}

async function settled(page: Page, selector: string) {
  await page.locator(selector).waitFor();
  await page.waitForFunction(() => {
    const roots = document.querySelectorAll(".main-content > :not(.notice)");
    if (roots.length !== 1) return false;
    const root = roots[0]!, style = getComputedStyle(root);
    return !/page-(enter|leave)-/.test(root.className) && style.opacity === "1" && style.transform === "none";
  });
}
const samples = (page: Page): Promise<MotionSample[]> => page.evaluate(() => (window as any).pageMotionSamples);
const navigate = async (page: Page, label: string, selector: string) => {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: label, exact: true }).click();
  await settled(page, selector);
};

try {
  await test("Direct access renders every page without an initial transition", async () => {
    for (const [path, selector] of [["/", ".store-card"], ["/accounts", ".account-grid"], ["/guide", ".guide-main"], ["/missing", "h1"]]) {
      await fixture(async page => {
        await page.goto(base + path);
        await settled(page, selector!);
        assert.deepEqual(await samples(page), []);
      });
    }
  });
  await test("Page transitions preserve the shell, data, history and same-page controls", async () => fixture(async (page, requests) => {
    await page.goto(base);
    await settled(page, ".store-card");
    await page.locator(".site-header").evaluate(element => { (window as any).originalHeader = element; });
    const headerBounds = await page.locator(".site-header").boundingBox();
    await navigate(page, "账号管理", ".account-grid");
    await navigate(page, "使用指南", ".guide-main");
    await page.goBack();
    await settled(page, ".account-grid");
    await page.goForward();
    await settled(page, ".guide-main");
    assert.equal(await page.title(), "使用指南 · 叠个饭");
    assert.equal(await page.locator(".visually-hidden[role='status']").textContent(), "使用指南 · 叠个饭");
    await navigate(page, "首页", ".store-card");
    assert.equal(await page.locator(".store-card h3").textContent(), offer.name);
    assert.deepEqual(requests, ["/api/dashboard"]);
    assert.equal(await page.locator(".site-header").evaluate(element => element === (window as any).originalHeader), true);
    assert.deepEqual(await page.locator(".site-header").boundingBox(), headerBounds);
    const motion = await samples(page);
    assert.ok(motion.some(sample => sample.classes.includes("page-leave-active") && sample.duration === "0.1s"));
    assert.ok(motion.some(sample => sample.classes.includes("page-enter-active") && sample.duration.includes("0.18s")));
    assert.ok(motion.every(sample => sample.pageCount === 1));
    await page.locator(".main-content > div").evaluate(element => { element.setAttribute("data-page-instance", "preserved"); });
    await page.getByRole("button", { name: "双方无需评价", exact: true }).click();
    await navigate(page, "首页", ".store-card");
    assert.equal(await page.locator(".main-content > div").getAttribute("data-page-instance"), "preserved");
    assert.equal((await samples(page)).length, motion.length);
  }));
  await test("Rapid navigation settles on the latest route without overlapping or stranded pages", async () => fixture(async page => {
    await page.goto(base);
    await settled(page, ".store-card");
    await page.evaluate(async () => {
      for (const path of ["/accounts", "/guide", "/", "/guide", "/accounts"]) {
        document.querySelector<HTMLAnchorElement>(`.main-nav a[href="${path}"]`)!.click();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    });
    await settled(page, ".account-grid");
    assert.equal(new URL(page.url()).pathname, "/accounts");
    assert.equal(await page.locator(".main-nav a[aria-current='page']").textContent(), "账号管理");
    assert.ok((await samples(page)).every(sample => sample.pageCount === 1));
    await navigate(page, "首页", ".store-card");
  }));
  await test("Desktop hash navigation uses the same transitions without restarting the native data bridge", async () => fixture(async page => {
    await page.goto(base + "/#/accounts");
    await settled(page, ".account-grid");
    assert.deepEqual(await samples(page), []);
    await navigate(page, "使用指南", ".guide-main");
    assert.equal(new URL(page.url()).hash, "#/guide");
    await navigate(page, "首页", ".store-card");
    assert.equal(new URL(page.url()).hash, "#/");
    assert.equal(await page.evaluate(() => (window as any).dashboardLoads), 1);
    assert.ok((await samples(page)).some(sample => sample.classes.includes("page-enter-active")));
  }, { desktop: true }));
  await test("Reduced motion keeps mobile page changes opaque, stationary and usable", async () => fixture(async page => {
    await page.goto(base + "/accounts");
    await settled(page, ".account-grid");
    await navigate(page, "使用指南", ".guide-main");
    await navigate(page, "首页", ".store-card");
    const motion = await samples(page);
    assert.ok(motion.length > 0);
    for (const sample of motion) {
      assert.equal(sample.duration, "0s");
      assert.equal(sample.opacity, "1");
      assert.equal(sample.transform, "none");
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }, { reducedMotion: true }));
  for (const width of [1280, 900, 390]) {
    await test(`Sync polling and completion preserve the current scroll position at ${width}px`, async () => fixture(async page => {
      await page.setViewportSize({ width, height: 820 });
      await page.clock.setFixedTime(new Date("2026-11-10T04:01:00Z"));
      const dashboard = structuredClone(data);
      dashboard.connections.xiaochan = { state: "connected", label: "已登录", profile: { userId: "1" } };
      dashboard.offers.xiaochan = Array.from({ length: 30 }, (_, index) => ({
        ...offer, id: `xiaochan:${index + 1}`, name: `滚动测试店 ${index + 1}`, meituanPoiId: String(index + 1),
      }));
      dashboard.offers.meituan = dashboard.offers.xiaochan.map(row => ({ ...row, id: `meituan:${row.meituanPoiId}`, provider: "meituan" }));
      let completeSync: (() => void) | undefined;
      const automaticRequests: boolean[] = [];
      await page.route("**/api/**", async route => {
        if (new URL(route.request().url()).pathname === "/api/sync") {
          automaticRequests.push(route.request().postDataJSON().automatic);
          await new Promise<void>(resolve => { completeSync = resolve; });
          return route.fulfill({ json: { data: dashboard, errors: [], message: "同步完成" } });
        }
        return route.fulfill({ json: dashboard });
      });
      const settleLayout = () => page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      ));
      const scrollTo = async (fraction: number) => {
        await page.evaluate(fraction => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * fraction), fraction);
        await settleLayout();
        const position = await page.evaluate(() => window.scrollY);
        assert.ok(position > 1000, "The fixture must extend beyond the viewport");
        return position;
      };
      const assertPosition = async (position: number, phase: string) => {
        await settleLayout();
        const current = await page.evaluate(() => window.scrollY);
        assert.ok(Math.abs(current - position) <= 2, `${phase}: expected scroll ${position}, received ${current}`);
      };
      try {
        await page.goto(base);
        await page.waitForFunction(() => document.querySelectorAll(".store-card").length === 30 && document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
        for (const automatic of [true, false]) {
          if (!automatic) await page.getByRole("button", { name: "同步活动", exact: true }).click();
          await page.getByRole("button", { name: "正在同步…", exact: true }).waitFor();
          for (const fraction of [0.5, 1]) {
            const position = await scrollTo(fraction);
            for (const row of dashboard.offers.xiaochan) row.inventory = row.inventory! - 1;
            const inventory = dashboard.offers.xiaochan[0]!.inventory;
            await page.waitForFunction(inventory => document.querySelector(".rebate-inventory")?.textContent === `剩 ${inventory} 份`, inventory);
            await assertPosition(position, `${automatic ? "Automatic" : "Manual"} sync polling`);
          }
          const position = await page.evaluate(() => window.scrollY);
          completeSync!();
          await page.getByRole("button", { name: "同步活动", exact: true }).waitFor();
          if (automatic) await assertPosition(position, "Automatic sync completion");
          else {
            await page.getByText("同步完成", { exact: true }).waitFor();
            await settleLayout();
            const current = await page.evaluate(() => window.scrollY);
            assert.ok(current >= position - 2 && current <= position + 150, "The completion notice must not send the page to the top");
          }
        }
        assert.deepEqual(automaticRequests, [true, false]);
      } finally { completeSync?.(); }
    }));
  }
} finally {
  await browser.close();
  server.httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
