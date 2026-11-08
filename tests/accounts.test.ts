import test from "node:test";
import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium, type Page } from "playwright-core";
import type { DashboardData } from "../shared/types";

const server = await preview({ configFile: false, logLevel: "silent", build: { outDir: "dist/client" }, preview: { host: "127.0.0.1", port: 0 } });
const address = server.httpServer.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });

function dashboard(connected = false): DashboardData {
  return {
    location: { label: "测试地址", cityCode: 310100, cityName: "上海市", latitude: 31.23, longitude: 121.47 },
    connections: {
      xiaochan: connected ? { state: "connected", label: "已登录", profile: {
        userId: "1234567890".repeat(8), nickname: "账号布局测试用户".repeat(3), phone: "138****0000",
      } } : { state: "disconnected", label: "未连接" },
      waimai: connected ? { state: "expired", label: "登录已失效", profile: { userId: "123", nickname: "测试用户" } }
        : { state: "disconnected", label: "未连接" },
      meituan: { state: "disconnected", label: "未连接" },
    },
    offers: { xiaochan: [], waimai: [], meituan: [] }, updatedAt: {}, enrollmentSchedules: [],
  };
}
async function fixture(connected: boolean, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage(), data = dashboard(connected);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === "/api/connections/xiaochan" && route.request().method() === "DELETE")
      data.connections.xiaochan = { state: "disconnected", label: "未连接" };
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: data });
    return route.continue();
  });
  try {
    await page.goto(base + "/accounts");
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(".verify-button");
      return button && !button.disabled;
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
async function equalPanels(page: Page) {
  const panels = await page.locator(".account-panel").evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { height: bounds.height, padding: style.padding, radius: style.borderRadius,
      contentBottom: element.lastElementChild!.getBoundingClientRect().bottom, bottom: bounds.bottom };
  }));
  assert.equal(panels.length, 3);
  assert.ok(Math.max(...panels.map(panel => panel.height)) - Math.min(...panels.map(panel => panel.height)) < 1);
  for (const panel of panels) {
    assert.equal(panel.padding, "24px");
    assert.equal(panel.radius, "14px");
    assert.ok(panel.contentBottom <= panel.bottom - 24);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
}

try {
  for (const connected of [false, true]) {
    await test(`Account panels stay equally tall across breakpoints with ${connected ? "mixed states and wrapped profiles" : "disconnected accounts"}`, async () => fixture(connected, async page => {
      assert.equal(await page.getByRole("link", { name: "返回首页", exact: true }).count(), 0);
      for (const width of [1440, 1280, 1000, 800, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await equalPanels(page);
      }
      await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "首页", exact: true }).click();
      await page.locator(".results-section").waitFor();
    }));
  }
  await test("Account panels remain equal after a profile is removed by disconnecting", async () => fixture(true, async page => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await equalPanels(page);
    page.once("dialog", dialog => { void dialog.accept(); });
    await page.locator(".account-panel").first().getByRole("button", { name: "断开", exact: true }).click();
    await page.locator(".account-panel").first().locator(".account-profile").waitFor({ state: "detached" });
    await equalPanels(page);
  }));
} finally {
  await browser.close();
  server.httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
