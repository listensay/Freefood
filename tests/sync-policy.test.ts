import "./fixtures/session-key";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createApp, toNodeListener } from "h3";
import { nextAutomaticSyncTime, nextAutomaticSyncCheck } from "../shared/utils/sync-time";

const directory = await mkdtemp(join(tmpdir(), "food-sync-policy-"));
process.env.FOOD_DATA_DIR = directory;
process.env.FOOD_ALLOW_LAN = "0";
const { sessionDatabase, closeSessionDatabase } = await import("../server/utils/session-database");
const { emptySession, saveSession, loadSession } = await import("../server/utils/session");
const { apiRouter } = await import("../server/routes");
const { exportRuntimeLogs } = await import("../server/utils/runtime-logs");
const fetchLocal = globalThis.fetch;
const minute = 60_000;
const start = Date.parse("2026-11-09T10:00:00Z");
const blockedMessage = "小蚕请求被拦截，请稍后重试";
const waf = () => new Response("<html>WAF拦截页面 腾讯云 WAF</html>", {
  status: 403, headers: { "content-type": "text/html" },
});
const emptyFeed = () => Response.json({ status: { code: 0 }, feed_items: [], has_more: false });

async function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const id = randomBytes(32).toString("hex");
  const session = emptySession();
  session.location = { label: "测试地址", cityName: "上海市", cityCode: 310100, latitude: 31.23, longitude: 121.47 };
  session.xiaochanAccount = { silkId: "123", userId: "456", accessToken: "test-token", platform: "mini" };
  session.connections.xiaochan = { state: "connected", label: "已登录" };
  await saveSession(id, session);
  const app = createApp(); app.use(apiRouter().handler);
  const server = createServer(toNodeListener(app));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const call = (automatic = false, sessionId = id) => fetchLocal(`http://127.0.0.1:${address.port}/api/sync`, {
    method: "POST", headers: { "content-type": "application/json", "x-food-request": "1", cookie: `food-session=${sessionId}` },
    body: JSON.stringify({ automatic }),
  });
  return { id, session, call };
}

try {
  await test("Daily synchronization slots include every hour and roll over at midnight in Shanghai", () => {
    const midnight = Date.parse("2026-11-09T00:00:00+08:00");
    for (let quarter = 0; quarter < 96; quarter++) {
      const boundary = midnight + quarter * 15 * minute;
      assert.equal(nextAutomaticSyncTime(boundary - 1, "xiaochan"), boundary);
      assert.equal(nextAutomaticSyncTime(boundary, "xiaochan"), boundary + 15 * minute);
      assert.equal(nextAutomaticSyncCheck(boundary), boundary + 5 * minute);
    }
  });

  await test("Xiaochan automatic sync follows 15-minute slots, while manual sync retains its 30-second interval", async t => {
    const { id, call } = await setup(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return emptyFeed(); });
    assert.equal((await call(true)).status, 200);
    t.mock.timers.tick(5 * minute);
    const early = await call(true);
    assert.equal(early.status, 429);
    assert.equal(early.headers.get("retry-after"), "600");
    assert.equal(requests, 1);
    assert.equal((await loadSession(id)).lastSyncByProvider?.xiaochan, start);
    t.mock.timers.tick(10 * minute);
    assert.equal((await call(true)).status, 200);
    assert.equal(requests, 2);
    assert.equal((await call()).status, 429);
    t.mock.timers.tick(30_000);
    assert.equal((await call()).status, 200);
    assert.equal(requests, 3);
    t.mock.timers.tick(5 * minute);
    assert.equal((await call(true)).status, 429);
    assert.equal(requests, 3);
  });

  await test("A manual sync immediately before the hour cannot postpone the hourly automatic sync", async t => {
    const { call } = await setup(t);
    t.mock.timers.setTime(start - 10_000);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return emptyFeed(); });
    assert.equal((await call()).status, 200);
    t.mock.timers.tick(10_000);
    assert.equal((await call(true)).status, 200);
    assert.equal(requests, 2);
    const duplicate = await call(true);
    assert.equal(duplicate.status, 429);
    assert.equal(duplicate.headers.get("retry-after"), "900");
    assert.equal(requests, 2);
    t.mock.timers.tick(15 * minute);
    assert.equal((await call(true)).status, 200);
    assert.equal(requests, 3);
  });

  await test("An hourly boundary never bypasses an active WAF cooldown", async t => {
    const { call } = await setup(t);
    t.mock.timers.setTime(start - 10_000);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return waf(); });
    await call();
    t.mock.timers.tick(10_000);
    assert.equal((await call(true)).status, 429);
    assert.equal(requests, 1);
  });

  await test("WAF cooldown blocks manual and automatic retries, doubles to 60 minutes and resets after recovery", async t => {
    const { id, session, call } = await setup(t);
    session.updatedAt.xiaochan = new Date(start - minute).toISOString();
    session.offers.xiaochan = [{ id: "xiaochan:42", provider: "xiaochan", name: "保留活动", category: "美食",
      rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 }, source: "live", collectedAt: new Date(start).toISOString() }];
    const previousOffers = structuredClone(session.offers.xiaochan);
    await saveSession(id, session);
    let requests = 0, blocked = true;
    t.mock.method(globalThis, "fetch", async () => { requests++; return blocked ? waf() : emptyFeed(); });
    for (const [index, minutes] of [15, 30, 60, 60].entries()) {
      const result = await (await call()).json();
      assert.deepEqual(result.errors, [blockedMessage]);
      assert.deepEqual(result.data.offers.xiaochan, previousOffers);
      assert.equal(result.data.xiaochanSyncBackoff, undefined);
      const state = (await loadSession(id)).xiaochanSyncBackoff!;
      assert.equal(state.consecutiveBlocks, Math.min(index + 1, 3));
      assert.equal(state.retryAt, Date.now() + minutes * minute);
      assert.deepEqual((await sessionDatabase()).read(id).xiaochanSyncBackoff, state);
      t.mock.timers.tick(minutes * minute - 1);
      for (const automatic of [false, true]) assert.equal((await call(automatic)).status, 429);
      assert.equal(requests, index + 1, "Skipped retries must not contact Xiaochan");
      assert.deepEqual((await loadSession(id)).xiaochanSyncBackoff, state, "Skipped retries must not extend the cooldown");
      t.mock.timers.tick(1);
    }
    blocked = false;
    assert.deepEqual((await (await call()).json()).errors, []);
    assert.equal((await loadSession(id)).xiaochanSyncBackoff, undefined);
    t.mock.timers.tick(30_000);
    blocked = true;
    await call();
    assert.equal((await loadSession(id)).xiaochanSyncBackoff?.retryAt, Date.now() + 15 * minute);
    assert.equal((await exportRuntimeLogs(id)).entries.filter(row => row.event === "request.end").length, 6);
  });

  await test("Persisted cooldown is enforced when loading a session from SQLite", async t => {
    const { id, call } = await setup(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return waf(); });
    await call();
    const saved = (await sessionDatabase()).read(id);
    closeSessionDatabase();
    const restoredId = randomBytes(32).toString("hex");
    (await sessionDatabase()).write(restoredId, saved);
    t.mock.timers.tick(minute);
    const retry = await call(false, restoredId);
    assert.equal(retry.status, 429);
    assert.equal(retry.headers.get("retry-after"), "840");
    assert.equal(requests, 1);
    assert.deepEqual((await loadSession(restoredId)).xiaochanSyncBackoff, saved.xiaochanSyncBackoff);
  });

  await test("Waimai continues syncing while Xiaochan cools down or waits for its automatic interval", async t => {
    const { id, session, call } = await setup(t);
    session.waimaiAccount = { userId: "test-user", uid: "123", token: "test-token" };
    session.connections.waimai = { state: "connected", label: "已登录" };
    await saveSession(id, session);
    const keys = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const cipher = createCipheriv("aes-128-ecb", Buffer.from("jnd674751fh6fkgu"), null);
    const config = Buffer.concat([cipher.update(JSON.stringify({
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
      privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    })), cipher.final()]).toString("base64");
    let xiaochanRequests = 0, waimaiRequests = 0, blocked = true;
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(input);
      if (url.hostname === "gw.xiaocantech.com") { xiaochanRequests++; return blocked ? waf() : emptyFeed(); }
      if (url.hostname === "fz-gateway.waimaimingtang.com") return Response.json({ code: 1, data: config });
      assert.equal(url.hostname, "wmapp-api-v2.waimaimingtang.com");
      waimaiRequests++;
      return Response.json({ code: 200, data: { data: [], scrollPageData: null } });
    });
    for (let round = 0; round < 3; round++) {
      if (round) t.mock.timers.tick(5 * minute);
      const response = await call(true);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.errors, [blockedMessage]);
      assert.equal(result.data.connections.waimai.state, "connected");
      assert.equal(xiaochanRequests, 1);
      assert.equal(waimaiRequests, (round + 1) * 2);
    }
    blocked = false;
    t.mock.timers.tick(5 * minute);
    assert.deepEqual((await (await call(true)).json()).errors, []);
    assert.equal(xiaochanRequests, 2);
    assert.equal((await loadSession(id)).xiaochanSyncBackoff, undefined);
    t.mock.timers.tick(5 * minute);
    assert.deepEqual((await (await call(true)).json()).errors, []);
    assert.equal(xiaochanRequests, 2);
    assert.equal(waimaiRequests, 10);
  });

  await test("WAF during enrollment reconciliation also starts the sync cooldown", async t => {
    const { id, session, call } = await setup(t);
    session.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9001", updatedAt: new Date(start).toISOString() } };
    await saveSession(id, session);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
      requests++;
      if (new Headers(init.headers).get("methodname") !== "FusionService.GetFeedPromotions") return waf();
      return Response.json({ status: { code: 0 }, has_more: false, feed_items: [{
        source: 1, store_platform: 1, promotion_id: 42, distance: 1000, store: { name: "测试活动" },
        order_money: 2000, user_rebate: 1500,
      }] });
    });
    const result = await (await call()).json();
    assert.deepEqual(result.errors, [blockedMessage]);
    assert.equal(result.data.offers.xiaochan[0].enrollment.orderId, "9001");
    assert.equal((await loadSession(id)).xiaochanSyncBackoff?.retryAt, start + 15 * minute);
    t.mock.timers.tick(minute);
    assert.equal((await call()).status, 429);
    assert.equal(requests, 2);
  });

  await test("Ordinary HTTP rejection does not start a WAF cooldown", async t => {
    const { id, call } = await setup(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("Forbidden", { status: 403 }); });
    await call();
    assert.equal((await loadSession(id)).xiaochanSyncBackoff, undefined);
    t.mock.timers.tick(30_000);
    await call();
    assert.equal(requests, 2);
  });

  await test("Concurrent retries after cooldown send once, and a location change cannot erase the new block", async t => {
    const { id, session, call } = await setup(t);
    session.xiaochanSyncBackoff = { consecutiveBlocks: 1, retryAt: start };
    await saveSession(id, session);
    const started = Promise.withResolvers<void>(), upstream = Promise.withResolvers<Response>();
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; started.resolve(); return upstream.promise; });
    const pending = call();
    try {
      await started.promise;
      assert.equal((await call(true)).status, 429);
      const current = await loadSession(id);
      current.location = { ...current.location!, label: "新地址", latitude: 31.24 };
      current.offers.xiaochan = [];
      await saveSession(id, current);
    } finally { upstream.resolve(waf()); }
    const result = await (await pending).json();
    assert.equal(result.data.location.label, "新地址");
    assert.deepEqual(result.data.offers.xiaochan, []);
    assert.deepEqual((await sessionDatabase()).read(id).xiaochanSyncBackoff, {
      consecutiveBlocks: 2, retryAt: start + 30 * minute,
    });
    assert.equal((await call()).status, 429);
    assert.equal(requests, 1);
  });
} finally {
  closeSessionDatabase();
  await rm(directory, { recursive: true, force: true });
}
