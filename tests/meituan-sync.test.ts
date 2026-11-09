import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const directory = await mkdtemp(join(tmpdir(), "food-meituan-sync-"));
const previousDirectory = process.env.FOOD_DATA_DIR;
process.env.FOOD_DATA_DIR = directory;
const { emptySession, loadSession, saveSession } = await import("../server/utils/session");
const { fetchMeituan, closeMeituan } = await import("../server/utils/meituan");
const location = { label: "测试地址", cityCode: 310000, latitude: 31.23, longitude: 121.47 };
const activity = {
  ret: 0,
  infos: [{
    poi_id_str: "fixture-poi",
    poiBaseInfo: { name: "测试门店", distance: "1.0km" },
    planActivityInfoList: [{ poiEventId: "fixture-event", userMaxRatio: 3500, userMaxCommission: 1500 }],
  }],
  hasMore: false,
};

function browserFixture() {
  const context = new EventEmitter();
  const page = new EventEmitter();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let connected = true, currentUrl = "about:blank";
  const fixture = {
    loads: 0,
    failRepeatedLoad: false,
    malformedIdentity: false,
    identityStatus: 200,
    expiredIdentity: false,
    omitIdentity: false,
    omitOffers: false,
    onNavigate: () => {},
    response(kind: "identity" | "offers" | "page", body: () => unknown, status = 200) {
      const path = kind === "identity" ? "getUserInfo" : kind === "offers" ? "queryPoiByRecallBiz" : "getPageModuleInfo";
      const request = {
        url: () => `https://offsiteact.meituan.com/act/ge/${path}`,
        method: () => "POST",
        timing: () => ({ startTime: Date.now() }),
        postData: () => JSON.stringify({ recallBizId: "cpsSelfPromotionOrder", pageNo: 1 }),
        allHeaders: async () => ({ "content-type": "application/json" }),
        frame: () => page,
      };
      let reads = 0;
      const response = {
        url: request.url,
        request: () => request,
        ok: () => status >= 200 && status < 300,
        status: () => status,
        headers: () => ({ "content-type": "application/json" }),
        json: async () => { reads++; return body(); },
      };
      context.emit("request", request);
      return { send: () => context.emit("response", response), reads: () => reads };
    },
  };
  Object.assign(page, {
    isClosed: () => !connected,
    url: () => currentUrl,
    async goto(url: string) {
      currentUrl = url;
      if (url === "about:blank") return;
      fixture.loads++;
      fixture.onNavigate();
      if (!fixture.omitIdentity) fixture.response("identity", () => {
        if (fixture.malformedIdentity) throw new SyntaxError("private-malformed-body-canary");
        if (fixture.failRepeatedLoad && fixture.loads > 1)
          throw new Error("Protocol error (Network.getResponseBody): No resource with given identifier found");
        return { ret: 0, data: { phone: fixture.expiredIdentity ? "" : "13800000000" } };
      }, fixture.identityStatus).send();
      // DOM readiness precedes activity responses on the real page.
      if (!fixture.omitOffers) timers.push(setTimeout(() => fixture.response("offers", () => activity).send(), 20));
      await Promise.resolve();
    },
  });
  Object.assign(context, {
    newPage: async () => page,
    setGeolocation: async () => {},
    addInitScript: async () => {},
    route: async () => {},
  });
  return {
    fixture,
    browser: {
      version: () => "157.0.0.0",
      isConnected: () => connected,
      newContext: async () => context,
      close: async () => { connected = false; timers.forEach(clearTimeout); },
    },
  };
}

async function setup(t: TestContext) {
  // Equal millisecond timestamps must not merge two sync generations.
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { fixture, browser } = browserFixture();
  t.mock.method(chromium, "launch", async () => browser as any);
  const id = randomBytes(32).toString("hex");
  const session = emptySession();
  session.location = location;
  session.connections.meituan = { state: "connected", label: "138****0000" };
  session.meituanStorage = { cookies: [], origins: [] };
  await saveSession(id, session);
  t.after(() => closeMeituan(id));
  return { id, fixture, advance: (ms: number) => { now += ms; } };
}

try {
  await test("Meituan logs reuse parsed responses and preserve status without private identity data", async t => {
    const now = Date.now();
    const { id, fixture } = await setup(t);
    t.mock.method(Date, "now", () => now);
    const { logOperation, exportRuntimeLogs } = await import("../server/utils/runtime-logs");
    await logOperation({ sessionId: id, action: "sync", provider: "meituan", source: "automatic" }, () => fetchMeituan(id, location));
    let logs = (await exportRuntimeLogs(id)).entries.filter(row => row.event === "request.end");
    assert.equal(logs.length, 2);
    assert.ok(logs.every(row => row.httpStatus === 200 && row.businessCode === 0 && row.source === "automatic"));
    assert.doesNotMatch(JSON.stringify(logs), /13800000000|fixture-poi|cookie/);
    fixture.identityStatus = 403; fixture.omitOffers = true;
    await assert.rejects(logOperation({ sessionId: id, action: "sync", provider: "meituan", source: "manual" }, () => fetchMeituan(id, location)));
    logs = (await exportRuntimeLogs(id)).entries.filter(row => row.event === "request.end");
    assert.equal(logs.at(-1)!.httpStatus, 403); assert.equal(logs.at(-1)!.reason, "access-denied");
    assert.equal(fixture.loads, 2);
  });

  await test("first Meituan sync loads the activity page once instead of cancelling its initial identity response", async t => {
    const { id, fixture } = await setup(t);
    fixture.failRepeatedLoad = true;
    const offers = await fetchMeituan(id, location, { radiusMeters: 7000 });
    assert.equal(offers.length, 1);
    assert.equal(fixture.loads, 1);
  });

  await test("reused Meituan sessions ignore late HTTP, malformed and identity responses from an earlier sync", async t => {
    const { id, fixture } = await setup(t);
    await fetchMeituan(id, location);
    const stale = [
      fixture.response("identity", () => ({ ret: 0, data: { phone: "" } })),
      fixture.response("identity", () => { throw new SyntaxError("private-stale-body"); }),
      fixture.response("page", () => ({}), 403),
      fixture.response("offers", () => ({}), 502),
    ];
    fixture.onNavigate = () => { stale.forEach(response => response.send()); };
    const offers = await fetchMeituan(id, location);
    assert.equal(offers.length, 1);
    assert.equal(fixture.loads, 2);
    assert.ok(stale.every(response => response.reads() === 0));
  });

  await test("an interrupted response body from a previous document cannot fail the current Meituan sync", async t => {
    const { id, fixture } = await setup(t);
    await fetchMeituan(id, location);
    let rejectBody!: (error: Error) => void;
    const body = new Promise((_, reject) => { rejectBody = reject; });
    const stale = fixture.response("identity", () => body);
    stale.send();
    assert.equal(stale.reads(), 1);
    fixture.onNavigate = () => rejectBody(new Error("Protocol error (Network.getResponseBody): No resource with given identifier found"));
    const offers = await fetchMeituan(id, location);
    assert.equal(offers.length, 1);
    assert.equal(fixture.loads, 2);
  });

  await test("a malformed identity response from the current sync still fails without changing the saved account or offers", async t => {
    const { id, fixture } = await setup(t);
    const session = await loadSession(id);
    session.offers.meituan = await fetchMeituan(id, location);
    await saveSession(id, session);
    const before = structuredClone(session);
    fixture.malformedIdentity = true;
    await assert.rejects(fetchMeituan(id, location), error => {
      assert.equal((error as any).statusCode, 502);
      assert.match((error as any).statusMessage, /无法解析美团身份响应/);
      assert.doesNotMatch((error as any).statusMessage, /private-/);
      return true;
    });
    assert.deepEqual(await loadSession(id), before);
  });

  for (const missing of ["identity", "offers"] as const) {
    await test(`Meituan retries one timed-out ${missing} response without accepting the abandoned load's responses`, async t => {
      const { id, fixture, advance } = await setup(t);
      let stale: ReturnType<typeof fixture.response>;
      fixture.onNavigate = () => {
        fixture.omitIdentity = fixture.loads === 1 && missing === "identity";
        fixture.omitOffers = fixture.loads === 1 && missing === "offers";
        if (fixture.loads === 1) {
          stale = fixture.response("identity", () => ({ ret: 0, data: { phone: "" } }));
          setTimeout(() => advance(30_001), 30);
        } else stale.send();
      };
      const offers = await fetchMeituan(id, location, { radiusMeters: 7000 });
      assert.equal(offers.length, 1);
      assert.equal(fixture.loads, 2);
      assert.equal(stale!.reads(), 0);
    });
  }

  await test("Meituan stops after one timeout retry and preserves previously saved activities", async t => {
    const { id, fixture, advance } = await setup(t);
    const session = await loadSession(id);
    session.offers.meituan = await fetchMeituan(id, location);
    await saveSession(id, session);
    const before = structuredClone(session);
    fixture.omitOffers = true;
    fixture.onNavigate = () => { setTimeout(() => advance(30_001), 30); };
    await assert.rejects(fetchMeituan(id, location), error => {
      assert.equal((error as any).statusCode, 504);
      assert.equal((error as any).statusMessage, "美团活动加载超时，请稍后重试");
      return true;
    });
    assert.equal(fixture.loads, 3);
    assert.deepEqual(await loadSession(id), before);
  });

  await test("an expired Meituan identity fails promptly without waiting for offers or retrying login", async t => {
    const { id, fixture, advance } = await setup(t);
    fixture.expiredIdentity = true;
    fixture.omitOffers = true;
    fixture.onNavigate = () => { setTimeout(() => advance(30_001), 30); };
    await assert.rejects(fetchMeituan(id, location), error => {
      assert.equal((error as any).statusCode, 401);
      assert.match((error as any).statusMessage, /美团登录已失效/);
      return true;
    });
    assert.equal(fixture.loads, 1);
  });

  await test("Meituan does not retry an explicit official identity refusal", async t => {
    const { id, fixture } = await setup(t);
    fixture.identityStatus = 403;
    fixture.omitOffers = true;
    await assert.rejects(fetchMeituan(id, location), error => {
      assert.equal((error as any).statusCode, 502);
      assert.match((error as any).statusMessage, /美团身份接口拒绝访问/);
      return true;
    });
    assert.equal(fixture.loads, 1);
  });
} finally {
  if (previousDirectory === undefined) delete process.env.FOOD_DATA_DIR;
  else process.env.FOOD_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
}
