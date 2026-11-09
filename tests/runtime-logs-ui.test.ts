import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { preview } from "vite";
import { chromium, type Page } from "playwright-core";
import type { RuntimeLog } from "../shared/runtime-logs";

const server = await preview({ configFile: false, logLevel: "silent", build: { outDir: "dist/client" }, preview: { host: "127.0.0.1", port: 0 } });
const address = server.httpServer.address(); assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const data = { location: null, connections: { xiaochan: { state: "disconnected", label: "未连接" }, waimai: { state: "disconnected", label: "未连接" }, meituan: { state: "disconnected", label: "未连接" } }, offers: { xiaochan: [], waimai: [], meituan: [] }, updatedAt: {} };
const row: RuntimeLog = { id: 101, timestamp: "2026-11-09T01:02:03.456Z", traceId: "abcdef12-3456-7890-abcd-123456789012", runId: "12345678-1234-5678-1234-567812345678", event: "request.end", action: "sync", provider: "xiaochan", source: "automatic", level: "error", outcome: "failure", reason: "gateway-blocked", httpStatus: 403, durationMs: 213, page: 2, gapMs: 6003, endpoint: "https://gw.xiaocantech.com/rpc", method: "POST", rpc: "SilkwormFusion.FusionService.GetFeedPromotions", client: "mini", clientVersion: "3.22.2.83" };
type Fixture = { page: Page; paths: string[]; queries: any[]; cleared: boolean; failQuery: boolean; failClear: boolean };
async function fixture(run: (state: Fixture) => Promise<void>, desktop = false) {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 820 } });
  const page = await context.newPage(), paths: string[] = [], queries: any[] = [], errors: string[] = [];
  const state: Fixture = { page, paths, queries, cleared: false, failQuery: false, failClear: false };
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  if (desktop) await page.addInitScript(({ data, row }) => {
    const state = window as any;
    state.isTauri = true; state.nativeCalls = [];
    state.__TAURI_INTERNALS__ = { async invoke(command: string, args: any) {
      state.nativeCalls.push({ command, ...args });
      if (command === "export_runtime_logs") return "/Downloads/freefood-logs.json";
      if (command !== "api_request") throw new Error("Unexpected native command");
      const result = args.path === "/api/dashboard" ? data : args.path === "/api/logs/query"
        ? { entries: state.cleared ? [] : [row], total: state.cleared ? 0 : 1, droppedEvents: 0 }
        : args.path === "/api/logs" ? (state.cleared = true, { cleared: true }) : null;
      if (!result) throw new Error("Unexpected native API");
      return { status: 200, body: JSON.stringify(result) };
    } };
  }, { data, row });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    paths.push(url.pathname);
    if (url.pathname === "/api/dashboard") return route.fulfill({ json: data });
    if (url.pathname === "/api/logs/query") {
      const query = route.request().postDataJSON(); queries.push(query);
      if (state.failQuery) return route.fulfill({ status: 500, json: { statusMessage: "加载失败" } });
      const empty = state.cleared || query.provider === "waimai";
      const entry = query.before ? { ...row, id: 1, outcome: "success", level: "info", reason: undefined } : row;
      return route.fulfill({ json: { entries: empty ? [] : [entry], total: empty ? 0 : 2, droppedEvents: 0, ...(!empty && !query.before ? { nextCursor: 101 } : {}) } });
    }
    if (url.pathname === "/api/logs/export") return route.fulfill({ json: { format: "freefood-runtime-logs", formatVersion: 1, exportedAt: row.timestamp, entries: [row] } });
    if (url.pathname === "/api/logs") {
      if (state.failClear) return route.fulfill({ status: 400, json: { statusMessage: "清空失败" } });
      state.cleared = true; return route.fulfill({ json: { cleared: true } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    await page.goto(base + (desktop ? "/#/logs" : "/logs"));
    await page.locator(".log-entry").waitFor();
    await run(state); assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

try {
  await test("Logs are readable on desktop/mobile, disclose details on demand and never trigger synchronization", async () => fixture(async ({ page, paths }) => {
    assert.equal(await page.getByRole("heading", { name: "运行日志", exact: true }).count(), 1);
    assert.equal(await page.getByRole("link", { name: "运行日志", exact: true }).getAttribute("aria-current"), "page");
    for (const width of [1440, 1280, 1100, 1000, 801, 800, 600, 390, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
      const nav = await page.locator(".main-nav").evaluate(element => [...element.children].map(child => child.getBoundingClientRect()).every((box, index, boxes) => !index || box.left >= boxes[index - 1]!.right));
      assert.equal(nav, true, `Overlapping navigation at ${width}`);
    }
    await page.locator(".log-entry summary").click();
    await page.getByText("SilkwormFusion.FusionService.GetFeedPromotions", { exact: true }).waitFor();
    assert.match(await page.locator(".log-entry").innerText(), /09:02:03/);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.clock.runFor(100);
    await page.screenshot({ path: "/tmp/freefood-runtime-logs-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.runFor(100);
    await page.screenshot({ path: "/tmp/freefood-runtime-logs-mobile.png", fullPage: true });
    assert.equal(paths.includes("/api/sync"), false);
  }));

  await test("Log filters, cursor paging and refresh use the dedicated query API", async () => fixture(async ({ page, queries }) => {
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".log-entry").length === 2);
    assert.equal(queries.at(-1).before, 101);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".log-entry").length === 1);
    await page.getByRole("combobox", { name: "日志平台" }).click();
    await page.getByRole("option", { name: "歪麦", exact: true }).click();
    await page.getByText("暂无日志", { exact: true }).waitFor(); assert.equal(queries.at(-1).provider, "waimai");
    await page.getByRole("combobox", { name: "日志平台" }).click();
    await page.getByRole("option", { name: "全部平台", exact: true }).click();
    await page.locator(".log-entry").waitFor();
    await page.getByRole("combobox", { name: "日志结果" }).click();
    await page.getByRole("option", { name: "网关拦截", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="日志列表"]')?.getAttribute("aria-busy") === "false");
    assert.equal(queries.at(-1).reason, "gateway-blocked"); assert.equal(queries.at(-1).before, undefined);
  }));

  await test("Export produces structured JSON and clear requires confirmation without clearing on cancel", async () => fixture(async ({ page, paths }) => {
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出日志", exact: true }).click();
    const download = await downloadEvent;
    const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
    assert.equal(exported.format, "freefood-runtime-logs"); assert.equal(exported.entries[0].httpStatus, 403);
    await page.getByRole("button", { name: "清空日志", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click(); assert.equal(paths.includes("/api/logs"), false);
    await page.getByRole("button", { name: "清空日志", exact: true }).click();
    await page.getByRole("button", { name: "清空", exact: true }).click();
    await page.getByText("日志已清空", { exact: true }).waitFor(); assert.equal(await page.locator(".log-entry").count(), 0);
    await page.clock.runFor(5100); assert.equal(await page.locator(".log-entry").count(), 0);
  }));

  await test("Failed log reads and clear keep existing entries and can be retried", async () => fixture(async state => {
    const { page } = state; state.failQuery = true;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByText("日志加载失败", { exact: true }).waitFor(); assert.equal(await page.locator(".log-entry").count(), 1);
    state.failQuery = false;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByText("日志加载失败", { exact: true }).waitFor({ state: "detached" });
    state.failClear = true;
    await page.getByRole("button", { name: "清空日志", exact: true }).click();
    await page.getByRole("button", { name: "清空", exact: true }).click();
    await page.getByText("清空失败", { exact: true }).waitFor(); assert.equal(await page.locator(".log-entry").count(), 1);
  }));

  await test("A query finishing after clear cannot restore deleted rows in the UI", async () => fixture(async ({ page }) => {
    let release!: () => Promise<void>;
    await page.route("**/api/logs/query", route => {
      release = () => route.fulfill({ json: { entries: [row], total: 1, droppedEvents: 0 } });
    });
    const pending = page.waitForRequest(request => request.url().endsWith("/api/logs/query"));
    await page.getByRole("button", { name: "刷新", exact: true }).click(); await pending;
    await page.getByRole("button", { name: "清空日志", exact: true }).click();
    await page.getByRole("button", { name: "清空", exact: true }).click();
    await page.getByText("日志已清空", { exact: true }).waitFor();
    await release(); await page.clock.runFor(100);
    assert.equal(await page.locator(".log-entry").count(), 0);
  }));

  await test("Leaving logs stops refresh timers and desktop log actions use the existing bridge", async () => {
    await fixture(async ({ page, queries }) => {
      await page.clock.runFor(5100); const count = queries.length; assert.ok(count >= 2);
      await page.getByRole("link", { name: "使用指南", exact: true }).click();
      await page.locator(".guide-main").waitFor();
      await page.clock.runFor(15_000); assert.equal(queries.length, count);
    });
    await fixture(async ({ page }) => {
      await page.getByRole("button", { name: "导出日志", exact: true }).click();
      await page.getByText("已导出到下载文件夹", { exact: true }).waitFor();
      await page.getByRole("button", { name: "清空日志", exact: true }).click();
      await page.getByRole("button", { name: "清空", exact: true }).click();
      await page.getByText("日志已清空", { exact: true }).waitFor();
      const calls = await page.evaluate(() => (window as any).nativeCalls);
      assert.ok(calls.some((call: any) => call.command === "export_runtime_logs"));
      assert.ok(calls.some((call: any) => call.path === "/api/logs" && call.method === "DELETE"));
      assert.ok(calls.every((call: any) => !call.path?.includes("?")));
    }, true);
  });
} finally { await browser.close(); server.httpServer.closeAllConnections(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); }
