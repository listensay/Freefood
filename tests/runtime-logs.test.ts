import "./fixtures/session-key";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createApp, toNodeListener } from "h3";
import { DatabaseSync } from "node:sqlite";
import type { LogExport, RuntimeLog } from "../shared/runtime-logs";

const directory = await mkdtemp(join(tmpdir(), "food-logs-"));
process.env.FOOD_DATA_DIR = directory;
process.env.FOOD_ALLOW_LAN = "0";
const { sessionDatabase, closeSessionDatabase, MAX_LOG_ENTRIES } = await import("../server/utils/session-database");
const { logOperation, withLogContext, logEvent, loggedRequest, queryRuntimeLogs, exportRuntimeLogs, clearRuntimeLogs } = await import("../server/utils/runtime-logs");
const { xiaochanRpc, xiaochanAccountHeaders } = await import("../server/utils/xiaochan-rpc");
const { fetchXiaochan } = await import("../server/utils/xiaochan");
const { verifyWaimaiAccount } = await import("../server/utils/waimai");
const { collectActivityPages } = await import("../server/utils/activity-pages");
const { apiRouter } = await import("../server/routes");
const { emptySession, saveSession } = await import("../server/utils/session");
const id = "a".repeat(64), other = "b".repeat(64);
const account = { silkId: "123", userId: "456", accessToken: "secret-access-canary", sessionId: "secret-session-canary", platform: "mini" as const };
const request = { headers: xiaochanAccountHeaders(account), serverName: "SilkwormFusion", methodName: "FusionService.GetFeedPromotions", body: { private: "secret-body-canary" } };
const location = { label: "private-address-canary", latitude: 31.23, longitude: 121.47, cityCode: 310100, cityName: "上海市" };
const waf = () => new Response("<html>WAF拦截页面 腾讯云 WAF secret-response-canary</html>", { status: 403, headers: { "content-type": "text/html", "retry-after": "60" } });
const execute = <T>(task: () => Promise<T>, sessionId = id) => logOperation({ sessionId, traceId: randomUUID(), action: "sync", source: "automatic", provider: "xiaochan" }, task);
const requests = async (sessionId = id) => (await exportRuntimeLogs(sessionId)).entries.filter(log => log.event === "request.end");

try {
  await sessionDatabase();
  await test("RPC logs retain transport evidence, trace, timing and client metadata without credentials or extra requests", async () => {
    await clearRuntimeLogs(id);
    let calls = 0;
    await assert.rejects(execute(() => xiaochanRpc(request, async () => { calls++; return waf(); })), /请求被拦截/);
    assert.equal(calls, 1);
    const exported = await exportRuntimeLogs(id), row = (await requests())[0]!;
    assert.equal(row.httpStatus, 403); assert.equal(row.reason, "gateway-blocked"); assert.equal(row.contentType, "html");
    assert.equal(row.retryAfterSeconds, 60); assert.equal(row.client, "mini"); assert.equal(row.source, "automatic");
    assert.equal(row.rpc, "SilkwormFusion.FusionService.GetFeedPromotions");
    assert.equal(row.endpoint, "https://gw.xiaocantech.com/rpc");
    assert.ok(row.durationMs! >= 0); assert.ok(row.inFlight! >= 1); assert.ok(row.requestsLastMinute! >= 1);
    assert.ok(exported.entries.every(entry => entry.traceId === row.traceId));
    assert.equal(exported.entries.at(-1)!.outcome, "failure");
    assert.doesNotMatch(JSON.stringify(exported), /secret-|private-address|x-sivir|accessToken|latitude/);
    assert.equal(exported.timezone, "UTC"); assert.equal(exported.displayTimezone, "Asia/Shanghai");
  });

  await test("HTTP, business errors, malformed JSON and timeouts stay distinguishable without replay", async () => {
    const cases: [() => Response | never, string, number | undefined, number | undefined][] = [
      [() => new Response("Forbidden", { status: 403 }), "access-denied", 403, undefined],
      [() => new Response("", { status: 429 }), "rate-limited", 429, undefined],
      [() => Response.json({ status: { code: 401 } }), "login-expired", 200, 401],
      [() => Response.json({ status: { code: 200001 } }), "verification", 200, 200001],
      [() => Response.json({ status: { code: 429 } }), "rate-limited", 200, 429],
      [() => new Response("not-json"), "invalid-response", 200, undefined],
      [() => { throw new DOMException("secret-network-canary", "TimeoutError"); }, "timeout", undefined, undefined],
      [() => { throw new TypeError("fetch failed secret-network-canary"); }, "network", undefined, undefined],
    ];
    for (const [respond, reason, status, code] of cases) {
      await clearRuntimeLogs(id);
      await assert.rejects(execute(() => xiaochanRpc(request, async () => respond())));
      const logs = await requests(); assert.equal(logs.length, 1);
      assert.equal(logs[0]!.reason, reason); assert.equal(logs[0]!.httpStatus, status); assert.equal(logs[0]!.businessCode, code);
    }
  });

  await test("Feed logging preserves response parsing and observes pagination without changing requests", async t => {
    await clearRuntimeLogs(id);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return waf(); });
    await assert.rejects(execute(() => fetchXiaochan(account, location)), /请求被拦截/);
    assert.equal(calls, 1); assert.equal((await requests())[0]!.reason, "gateway-blocked");
    t.mock.restoreAll();
    await execute(() => collectActivityPages(async page => ({ offers: [], rowKeys: [String(page)], hasMore: page < 1 }), 7000, { delayMs: 0 }));
    const pages = (await exportRuntimeLogs(id)).entries.filter(entry => entry.event === "page.end");
    assert.deepEqual(pages.map(entry => [entry.page, entry.rows, entry.hasMore]), [[1, 1, true], [2, 1, false]]);
  });

  await test("Waimai parsing records business outcomes and finishes each request only once", async () => {
    for (const [data, reason] of [[{ code: 13001 }, "verification"], [{ code: 429 }, "rate-limited"], ["not-json", "invalid-response"]] as const) {
      await clearRuntimeLogs(id);
      await assert.rejects(logOperation({ sessionId: id, action: "profile", provider: "waimai", source: "manual" }, () =>
        verifyWaimaiAccount({ uid: "123", userId: "456", token: "secret-token-canary" }, async () => typeof data === "string" ? new Response(data) : Response.json(data))));
      const logs = await requests(); assert.equal(logs.length, 1); assert.equal(logs[0]!.reason, reason);
    }
  });

  await test("Concurrent traces and session logs remain isolated, and metadata excludes unknown fields", async () => {
    await clearRuntimeLogs(id); await clearRuntimeLogs(other);
    await Promise.all([id, other].map((sessionId, index) => execute(() => loggedRequest({ provider: "xiaochan", method: "POST",
      endpoint: "https://gw.xiaocantech.com/rpc?token=private-canary#secret", businessCode: NaN,
      ...({ headers: { token: "private-canary" }, message: "private-canary" } as any),
    }, async log => {
      await new Promise(resolve => setTimeout(resolve, index ? 0 : 10));
      log.response(200, "application/json"); log.business(0);
      return { private: "private-canary" };
    }), sessionId)));
    const a = await exportRuntimeLogs(id), b = await exportRuntimeLogs(other);
    assert.notEqual(a.entries[0]!.traceId, b.entries[0]!.traceId);
    assert.equal(a.entries.filter(row => row.event === "request.end").length, 1);
    assert.doesNotMatch(JSON.stringify([a, b]), /private-canary|headers|token=|#secret/);
  });

  await test("Logging storage failures never change the operation result and are reported separately", async () => {
    await clearRuntimeLogs(id);
    const sql = new DatabaseSync(join(directory, "food.sqlite3"));
    sql.exec("CREATE TRIGGER reject_log BEFORE INSERT ON runtime_logs BEGIN SELECT RAISE(ABORT, 'test log failure'); END");
    try { assert.equal(await execute(async () => 42), 42); assert.ok((await queryRuntimeLogs(id)).droppedEvents >= 2); }
    finally { sql.exec("DROP TRIGGER reject_log"); sql.close(); }
    await clearRuntimeLogs(id); assert.equal((await queryRuntimeLogs(id)).droppedEvents, 0);
  });

  await test("Log persistence, retention, cursor paging and clear leave account snapshots unchanged", async () => {
    const database = await sessionDatabase(), snapshot = { private: "account-canary", scheduled: true };
    database.write(id, snapshot); await clearRuntimeLogs(id); await clearRuntimeLogs(other);
    const seed: Omit<RuntimeLog, "id"> = { timestamp: new Date().toISOString(), runId: randomUUID(), traceId: randomUUID(), event: "request.end", action: "sync", source: "manual", provider: "xiaochan", outcome: "success", level: "info" };
    database.appendLog(id, seed); database.appendLog(other, seed);
    const sql = new DatabaseSync(join(directory, "food.sqlite3"));
    sql.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?)
      INSERT INTO runtime_logs(session_id,timestamp,provider,level,reason,payload)
      SELECT session_id,timestamp,provider,level,reason,payload FROM runtime_logs,numbers WHERE session_id=?`).run(MAX_LOG_ENTRIES + 5, id);
    sql.close(); database.appendLog(id, seed);
    const first = database.queryLogs(id); assert.equal(first.total, MAX_LOG_ENTRIES); assert.equal(first.entries.length, 100);
    const second = database.queryLogs(id, { before: first.nextCursor });
    assert.ok(second.entries.every(row => row.id < first.entries.at(-1)!.id));
    database.appendLog(id, { ...seed, timestamp: new Date(Date.now() - 15 * 86400_000).toISOString() });
    assert.equal(database.queryLogs(id).total, MAX_LOG_ENTRIES);
    closeSessionDatabase();
    assert.doesNotMatch((await readFile(join(directory, "food.sqlite3"))).toString("latin1"), /account-canary|"traceId"/);
    assert.deepEqual((await sessionDatabase()).read(id), snapshot);
    assert.equal((await queryRuntimeLogs(id)).total, MAX_LOG_ENTRIES);
    await clearRuntimeLogs(id); assert.equal((await queryRuntimeLogs(id)).total, 0);
    assert.equal((await queryRuntimeLogs(other)).total, 1);
    assert.deepEqual((await sessionDatabase()).read(id), snapshot);
  });

  await test("Log APIs enforce request/session boundaries, validation and no self-logging", async () => {
    await clearRuntimeLogs(id); await clearRuntimeLogs(other);
    const app = createApp(); app.use(apiRouter().handler);
    const server = createServer(toNodeListener(app));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const call = (path: string, method = "POST", body: unknown = {}, sessionId = id, headers = {}) => fetch(base + path, {
      method, headers: { "content-type": "application/json", "x-food-request": "1", cookie: `food-session=${sessionId}`, ...headers },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    try {
      withLogContext({ sessionId: id }, () => logEvent({ event: "operation.end", outcome: "failure", reason: "gateway-blocked", provider: "xiaochan" }));
      for (const body of [{ before: -1 }, { before: 0.5 }, { provider: "unknown" }, { reason: "__proto__" }, { level: "fatal" }, []])
        assert.equal((await call("/api/logs/query", "POST", body)).status, 400);
      assert.equal((await call("/api/logs/query", "POST", {}, id, { "x-food-request": "0" })).status, 403);
      assert.equal((await call("/api/logs/export", "GET", {}, id, { origin: "https://example.com" })).status, 403);
      assert.equal((await (await call("/api/logs/query", "POST", {}, other)).json()).total, 0);
      const filtered = await call("/api/logs/query", "POST", { provider: "xiaochan", reason: "gateway-blocked" });
      assert.equal(filtered.headers.get("cache-control"), "no-store"); assert.equal((await filtered.json()).total, 1);
      const exported: LogExport = await (await call("/api/logs/export", "GET")).json(); assert.equal(exported.entries.length, 1);
      await call("/api/logs", "DELETE");
      assert.equal((await (await call("/api/logs/query")).json()).total, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  await test("Automatic API sync failures record the feed error under the correct session and source", async t => {
    await clearRuntimeLogs(id);
    const session = emptySession(); session.location = location; session.xiaochanAccount = account;
    session.connections.xiaochan = { state: "connected", label: "已登录" }; await saveSession(id, session);
    const fetchLocal = globalThis.fetch;
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return waf(); });
    const app = createApp(); app.use(apiRouter().handler);
    const server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    try {
      const result = await fetchLocal(`http://127.0.0.1:${address.port}/api/sync`, { method: "POST", headers: {
        "content-type": "application/json", "x-food-request": "1", cookie: `food-session=${id}`,
      }, body: JSON.stringify({ automatic: true }) });
      assert.equal(result.status, 200); assert.equal((await result.json()).errors.length, 1); assert.equal(calls, 1);
      const logs = (await exportRuntimeLogs(id)).entries;
      assert.ok(logs.every(row => row.source === "automatic"));
      assert.equal(logs.find(row => row.event === "request.end")!.reason, "gateway-blocked");
      assert.equal(logs.at(-1)!.outcome, "failure");
    } finally { t.mock.restoreAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
} finally { closeSessionDatabase(); await rm(directory, { recursive: true, force: true }); }
