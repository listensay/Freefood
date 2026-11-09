import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { preview } from "vite";
import { chromium, type Locator, type Page } from "playwright-core";
import type { DashboardData, Offer } from "../shared/types";

const server = await preview({ configFile: false, logLevel: "silent", build: { outDir: "dist/client" }, preview: { host: "127.0.0.1", port: 0 } });
const address = server.httpServer.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const offer: Offer = {
  id: "xiaochan:42", provider: "xiaochan", name: "样式测试店", category: "美食", meituanPoiId: "42",
  source: "live", collectedAt: "2026-11-08T04:00:00Z", inventory: 3, distanceMeters: 1000,
  startTime: "13:00", endTime: "14:00", validFrom: "2026-11-08T05:00:00Z", requirement: "无需评价",
  rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
};
const data: DashboardData = {
  location: { label: "测试地址", cityName: "上海市", cityCode: 310100, latitude: 31.23, longitude: 121.47 },
  connections: {
    xiaochan: { state: "connected", label: "已登录", profile: { userId: "123", nickname: "测试用户" } },
    waimai: { state: "connected", label: "已登录", profile: { userId: "456" } },
    meituan: { state: "disconnected", label: "未连接" },
  },
  offers: {
    xiaochan: [offer], waimai: [{ ...offer, id: "waimai:1:2", provider: "waimai", enrollmentAvailable: true }],
    meituan: [{ ...offer, id: "meituan:1", provider: "meituan" }],
  }, updatedAt: {}, enrollmentSchedules: [],
};
async function fixture(run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-11-08T04:00:00Z"));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === "/api/xiaochan/schedule-options") return route.fulfill({ json: {
      offerId: offer.id, advanceWindows: [{ start: Date.parse("2026-11-08T04:30:00Z"), end: Date.parse("2026-11-08T05:00:00Z") }],
    } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: url.pathname === "/api/sync"
      ? { data, errors: [], message: "同步完成" } : data });
    return route.continue();
  });
  try {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector(".store-card") && !document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
const style = (element: Locator, properties: string[]) => element.evaluate((element, properties) => {
  const computed = getComputedStyle(element);
  return Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)]));
}, properties);

try {
  await test("The shared stylesheet contains only theme configuration and element defaults", async () => {
    const css = await readFile("app/assets/css/main.css", "utf8");
    assert.match(css, /@import "tailwindcss\/utilities\.css"/);
    assert.match(css, /@layer base/);
    assert.doesNotMatch(css, /^\s*[^@\n{}]*\.[A-Za-z_-][\w-]*[^{}]*\{/m, "Component selectors belong in component utility classes");
    assert.doesNotMatch(css, /@apply\b/);
    for (const path of await readdir("app", { recursive: true })) {
      if (!path.endsWith(".vue")) continue;
      assert.doesNotMatch(await readFile(`app/${path}`, "utf8"), /<style(?:\s|>)/, `${path} must use utilities rather than moving the old stylesheet into a style block`);
    }
  });
  await test("Tailwind utilities preserve card dimensions, default typography and exact responsive boundaries", async () => fixture(async page => {
    for (const width of [1280, 1100, 801, 800, 601, 600, 375, 370, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const columns = await page.locator(".store-grid").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      assert.equal(columns, width <= 600 ? 1 : width <= 1100 ? 2 : 3);
      assert.deepEqual(await style(page.locator(".store-card").first(), ["border-radius", "padding"]), {
        "border-radius": "14px", padding: width <= 370 ? "20px 16px 0px" : width <= 600 ? "20px 20px 0px" : "24px 24px 0px",
      });
      assert.equal((await style(page.locator(".filter-tabs button").first(), ["padding-left"]))["padding-left"], "0px");
      assert.deepEqual(await style(page.locator(".sync-button"), ["border-radius", "min-height", "font-size"]), {
        "border-radius": "9999px", "min-height": width <= 600 ? "44px" : "48px", "font-size": width <= 600 ? "13px" : "14px",
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
  }));
  await test("Button, filter, notice and field states keep their original colors and spacing", async () => fixture(async page => {
    const sync = page.locator(".sync-button");
    assert.deepEqual(await style(sync, ["background-color", "color"]), { "background-color": "rgb(255, 56, 92)", color: "rgb(255, 255, 255)" });
    await sync.hover();
    assert.equal((await style(sync, ["background-color"]))["background-color"], "rgb(224, 11, 65)");
    await sync.click();
    await page.getByText("同步完成", { exact: true }).waitFor();
    assert.deepEqual(await style(page.locator(".notice"), ["padding", "font-size", "margin-bottom"]), {
      padding: "16px", "font-size": "14px", "margin-bottom": "32px",
    });
    assert.deepEqual(await style(page.locator(".notice > span"), ["flex-grow", "overflow-wrap"]), {
      "flex-grow": "1", "overflow-wrap": "anywhere",
    });
    const enrollment = page.locator('.store-card[data-provider="xiaochan"] .enrollment-button');
    assert.equal(await enrollment.isDisabled(), true);
    assert.deepEqual(await style(enrollment, ["background-color", "color", "min-height"]), {
      "background-color": "rgb(255, 209, 218)", color: "rgb(255, 255, 255)", "min-height": "36px",
    });
    const selected = page.getByRole("button", { name: "双方无需评价", exact: true });
    await selected.click();
    assert.deepEqual(await style(selected, ["color", "font-weight"]), { color: "rgb(224, 11, 65)", "font-weight": "600" });
    const underline = await selected.evaluate(element => { const s = getComputedStyle(element, "::after"); return [s.height, s.bottom, s.backgroundColor]; });
    assert.deepEqual(underline, ["2px", "-1px", "rgb(255, 56, 92)"]);
    await page.locator(".location-button").click();
    const dialog = page.getByRole("dialog", { name: "收餐地址", exact: true });
    const input = dialog.getByLabel("地址名称");
    await input.focus();
    assert.deepEqual(await style(input, ["border-color", "background-color", "padding"]), {
      "border-color": "rgb(224, 11, 65)", "background-color": "rgb(255, 255, 255)", padding: "9px 12px",
    });
    await input.fill("");
    await dialog.getByRole("button", { name: "保存地址", exact: true }).click();
    assert.equal((await style(input, ["border-color"]))["border-color"], "rgb(193, 53, 21)");
  }));
  await test("Coupon switches and time menus preserve layout, focus, checked and selected states", async () => fixture(async page => {
    await page.locator('.store-card[data-provider="xiaochan"] .schedule-enrollment-button').click();
    const dialog = page.getByRole("dialog", { name: "预约报名", exact: true });
    await dialog.getByText("最早 12:30", { exact: true }).waitFor();
    const toggle = dialog.getByRole("switch", { name: /使用超前抢单券/ });
    await toggle.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.deepEqual(await style(dialog.locator(".ui-switch-track"), ["background-color", "outline-color", "outline-width"]), {
      "background-color": "rgb(255, 56, 92)", "outline-color": "rgb(224, 11, 65)", "outline-width": "2px",
    });
    for (const width of [1280, 375, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.deepEqual(await style(dialog.locator(".schedule-coupon-option"), ["display", "gap", "padding", "font-size"]), {
        display: "flex", gap: "16px", padding: "8px 12px", "font-size": "14px",
      });
      assert.equal((await style(dialog.locator(".ui-switch-thumb"), ["transform"])).transform, `matrix(1, 0, 0, 1, ${width <= 370 ? 12 : 16}, 0)`);
      await dialog.getByRole("combobox", { name: "报名分钟" }).click();
      const menu = dialog.getByRole("listbox", { name: "报名分钟" });
      assert.deepEqual(await style(menu, ["max-height", "overflow-y"]), { "max-height": "240px", "overflow-y": "auto" });
      const triggerBounds = await dialog.getByRole("combobox", { name: "报名分钟" }).boundingBox(), menuBounds = await menu.boundingBox();
      assert.ok(triggerBounds && menuBounds);
      assert.equal(menuBounds.y - triggerBounds.y - triggerBounds.height, 8);
      assert.equal((await style(menu.getByRole("option", { selected: true }), ["color"])).color, "rgb(224, 11, 65)");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
    await toggle.uncheck();
    assert.equal((await style(dialog.locator(".ui-switch-track"), ["background-color"]))["background-color"], "rgb(106, 106, 106)");
    assert.equal((await style(dialog.locator(".ui-switch-thumb"), ["transform"])).transform, "none");
  }));
} finally {
  await browser.close();
  server.httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
