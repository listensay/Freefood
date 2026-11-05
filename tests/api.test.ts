import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { requestWithHost } from "./fixtures/http";

const directory = await mkdtemp(join(tmpdir(), "food-api-"));
const port = 19000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", join(process.cwd(), "tests/fixtures/waimai-upstream.mjs"), ".output/server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    FOOD_ALLOW_LAN: "0",
    PORT: String(port),
    FOOD_DATA_DIR: directory,
  },
  stdio: "pipe",
});
let output = "";
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Production server failed to start: ${output}`);
  const init = await fetch(`${base}/api/dashboard`);
  const cookie = init.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(init.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(init.headers.get("set-cookie")!, /SameSite=Strict/i);
  const other = await fetch(`${base}/api/dashboard`);
  const cookie2 = other.headers.get("set-cookie")!.split(";")[0]!;
  const call = (
    path: string,
    body?: unknown,
    method = "POST",
    userCookie = cookie,
    extra = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        cookie: userCookie,
        "x-food-request": "1",
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await test("production page loads and API contains no raw session fields", async () => {
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("cache-control"), "no-store");
    const data = await init.json();
    assert.equal(data.xiaochanHeaders, undefined);
    assert.equal(data.waimaiToken, undefined);
    assert.equal(data.meituanStorage, undefined);
    assert.equal(data.location, null);
    assert.deepEqual(data.offers, { xiaochan: [], waimai: [], meituan: [] });
  });
  await test("homepage keeps synchronization without the activity availability switch", async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /同步活动/);
    assert.doesNotMatch(html, /仅看有效活动|role="switch"/);
  });
  await test("cross-origin and missing-header mutations are rejected", async () => {
    assert.equal(
      (
        await call("/api/location", {}, "POST", cookie, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/import", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
  });
  await test("local mode rejects private and public Host headers without trusting forwarded hosts", async () => {
    for (const host of ["192.168.1.20", "8.8.8.8", "evil.example"])
      assert.equal((await requestWithHost(base + "/api/dashboard", {
        headers: { host: `${host}:${port}`, "x-forwarded-host": `localhost:${port}` },
      })).status, 403);
  });
  await test("malformed session is not accepted as login", async () => {
    assert.equal(
      (await call("/api/connections/xiaochan", { session: '{"token":"fake"}' }))
        .status,
      400,
    );
  });
  await test("session connection is configured, not falsely verified", async () => {
    const r = await call("/api/connections/xiaochan", {
      session:
        '{"x-teemo":"11223344","x-vayne":"556677","authorization":"Bearer private-test-secret"}',
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes("private-test-secret"));
    assert.equal(JSON.parse(text).connections.xiaochan.state, "configured");
    const files = await readdir(directory);
    const encrypted = await readFile(
      join(
        directory,
        files.find((name) => name.endsWith(".enc"))!,
      ),
    );
    assert.ok(!encrypted.includes(Buffer.from("private-test-secret")));
  });
  await test("synchronization requires a user-provided location", async () => {
    const response = await call("/api/sync");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).statusMessage, "请先设置收餐地址");
  });
  await test("Waimai token connection remains unverified and its secret is encrypted", async () => {
    const r = await call("/api/connections/waimai", { token: "api-private-waimai-token" });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes("api-private-waimai-token"));
    assert.equal(JSON.parse(text).connections.waimai.state, "configured");
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".enc")))
      assert.ok(!(await readFile(join(directory, name))).includes(Buffer.from("api-private-waimai-token")));
    assert.equal((await call("/api/connections/waimai", { token: "bad\r\nheader" })).status, 400);
    assert.equal((await call("/api/connections/waimai", {})).status, 400);
    assert.equal((await call("/api/sync", { provider: "unknown" })).status, 400);
  });
  const row = {
    id: "001",
    name: "API 测试（同一分店）",
    meituanPoiId: "1122",
    rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 2000 },
  };
  await test("imports persist valid normalized offers without authenticating provider", async () => {
    assert.equal(
      (await call("/api/import", { provider: "xiaochan", offers: [row] }))
        .status,
      200,
    );
    const r = await call("/api/import", {
      provider: "meituan",
      offers: [
        {
          ...row,
          rule: {
            kind: "percentage",
            thresholdCents: 0,
            ratioBps: 3000,
            capCents: 1000,
          },
        },
      ],
    });
    const d = await r.json();
    assert.equal(d.offers.meituan.length, 1);
    assert.equal(d.connections.meituan.state, "disconnected");
    assert.equal(d.offers.meituan[0].source, "import");
    assert.equal(
      (
        await call("/api/import", {
          provider: "xiaochan",
          offers: [{ ...row, rule: { ...row.rule, cashbackCents: -10 } }],
        })
      ).status,
      400,
    );
  });
  await test("Waimai import preserves other providers and normalizes IDs", async () => {
    const d = await (await call("/api/import", { provider: "waimai", offers: [row] })).json();
    assert.equal(d.offers.waimai[0].id, "waimai:001");
    assert.equal(d.offers.waimai[0].source, "import");
    assert.equal(d.offers.xiaochan.length, 1);
    assert.equal(d.offers.meituan.length, 1);
  });
  await test("different browser sessions never share credentials or imported offers", async () => {
    const r = await fetch(base + "/api/dashboard", {
      headers: { cookie: cookie2 },
    });
    const d = await r.json();
    assert.equal(d.offers.xiaochan.length, 0);
    assert.equal(d.connections.xiaochan.state, "disconnected");
    assert.equal(d.connections.waimai.state, "disconnected");
    assert.equal(d.offers.waimai.length, 0);
  });
  await test("legacy two-provider sessions gain Waimai without losing existing offers or accounts", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie } })).json();
    delete snapshot.connections.waimai;
    delete snapshot.offers.waimai;
    const id = randomBytes(32).toString("hex"), iv = randomBytes(12);
    const key = await readFile(join(directory, "session.key"));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    await writeFile(join(directory, `${id}.enc`), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    const d = await (await fetch(base + "/api/dashboard", { headers: { cookie: `food-session=${id}` } })).json();
    assert.deepEqual(d.offers.waimai, []);
    assert.equal(d.connections.waimai.state, "disconnected");
    assert.equal(d.connections.xiaochan.state, "configured");
    assert.equal(d.offers.xiaochan.length, 1);
    assert.equal(d.offers.meituan.length, 1);
  });
  await test("stored obsolete activities are removed without deleting imported data", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie } })).json();
    snapshot.offers.xiaochan.push({
      ...snapshot.offers.xiaochan[0], id: "obsolete-activity", source: "legacy",
    });
    const id = randomBytes(32).toString("hex"), iv = randomBytes(12);
    const key = await readFile(join(directory, "session.key"));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    const path = join(directory, `${id}.enc`);
    await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    const response = await fetch(base + "/api/dashboard", { headers: { cookie: `food-session=${id}` } });
    const data = await response.json();
    assert.equal(data.offers.xiaochan.length, 1);
    assert.equal(data.offers.xiaochan[0].source, "import");
    assert.equal(data.offers.meituan.length, 1);
    const saved = await readFile(path);
    const decipher = createDecipheriv("aes-256-gcm", key, saved.subarray(0, 12));
    decipher.setAuthTag(saved.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(saved.subarray(28)), decipher.final()]).toString();
    assert.ok(!plaintext.includes("obsolete-activity"));
  });
  await test("location change clears all previous-location offers but keeps connections", async () => {
    const r = await call("/api/location", {
      label: "上海",
      cityCode: 310000,
      cityName: "上海市",
      latitude: 31.23,
      longitude: 121.47,
    });
    const d = await r.json();
    assert.equal(d.offers.xiaochan.length, 0);
    assert.equal(d.offers.meituan.length, 0);
    assert.equal(d.offers.waimai.length, 0);
    assert.equal(d.location.cityName, "上海市");
    assert.equal(d.connections.xiaochan.state, "configured");
  });
  await test("selected Waimai synchronization leaves Xiaochan untouched and enforces cooldown", async () => {
    await call("/api/import", { provider: "xiaochan", offers: [row] });
    const r = await call("/api/sync", { provider: "waimai" });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.waimai.length, 1);
    assert.equal(result.data.offers.waimai[0].rule.cashbackCents, 2000);
    assert.equal(result.data.offers.waimai[0].source, "live");
    assert.equal(result.data.offers.xiaochan[0].source, "import");
    assert.equal(result.data.connections.waimai.state, "configured");
    assert.equal(result.data.waimaiToken, undefined);
    assert.equal((await call("/api/sync", { provider: "waimai" })).status, 429);
  });
  await test("guest access can sync without an account but requires an explicit city name", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    const connected = await (await call("/api/connections/waimai", { token: "" }, "POST", c)).json();
    assert.equal(connected.connections.waimai.label, "访客访问");
    await call("/api/location", { label: "收餐地址", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", c);
    assert.equal((await call("/api/sync", { provider: "waimai" }, "POST", c)).status, 400);
    await call("/api/location", { label: "收餐地址", cityName: "上海市", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", c);
    const result = await (await call("/api/sync", { provider: "waimai" }, "POST", c)).json();
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.waimai.length, 1);
    assert.equal(result.data.connections.waimai.label, "访客访问");
  });
  for (const token of ["expired-test-token", "network-failure-token"]) {
    await test(`Waimai ${token} preserves the last successful dataset`, async () => {
      const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
      await call("/api/location", { label: "收餐地址", cityName: "上海市", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", c);
      await call("/api/connections/waimai", { token }, "POST", c);
      await call("/api/import", { provider: "waimai", offers: [row] }, "POST", c);
      const result = await (await call("/api/sync", { provider: "waimai" }, "POST", c)).json();
      assert.equal(result.errors.length, 1);
      assert.equal(result.data.offers.waimai[0].id, "waimai:001");
      assert.equal(result.data.connections.waimai.state, token === "expired-test-token" ? "expired" : "configured");
    });
  }
  await test("disconnecting Waimai clears only its credentials and activities", async () => {
    const response = await call("/api/connections/waimai", undefined, "DELETE");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.connections.waimai.state, "disconnected");
    assert.deepEqual(data.offers.waimai, []);
    assert.equal(data.updatedAt.waimai, undefined);
    assert.equal(data.connections.xiaochan.state, "configured");
    assert.equal(data.offers.xiaochan.length, 1);
  });
  await test("disconnect removes credentials and unknown provider is rejected", async () => {
    const r = await call("/api/connections/xiaochan", undefined, "DELETE");
    assert.equal((await r.json()).connections.xiaochan.state, "disconnected");
    assert.equal(
      (await call("/api/connections/not-a-provider", undefined, "DELETE"))
        .status,
      400,
    );
  });
  await test("captured Xiaochan headers save an encrypted unverified session", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers
      .get("set-cookie")!
      .split(";")[0]!;
    const response = await call(
      "/api/connections/xiaochan",
      {
        session:
          ":method: POST\n:authority: gw.xiaocantech.com\n:path: /rpc\n:scheme: https\nx-teemo: 123456\nx-vayne: 6789\nx-sivir: captured-test-secret",
      },
      "POST",
      c,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes("captured-test-secret"));
    assert.equal(JSON.parse(text).connections.xiaochan.state, "configured");
    for (const name of (await readdir(directory)).filter((name) =>
      name.endsWith(".enc"),
    ))
      assert.ok(
        !(await readFile(join(directory, name))).includes(
          Buffer.from("captured-test-secret"),
        ),
      );
    assert.equal(
      (
        await call(
          "/api/connections/xiaochan",
          { session: "https://gw.xiaocantech.com/rpc" },
          "POST",
          c,
        )
      ).status,
      400,
    );
  });
  await test("first automatic location preserves imports while subsequent location changes clear them", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    const address = { automatic: true, label: "南宁市青秀区", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    const first = await (await call("/api/location", address, "POST", c)).json();
    assert.equal(first.location.cityName, "南宁市");
    assert.equal(first.offers.xiaochan[0].id, "xiaochan:001");
    assert.ok(first.updatedAt.xiaochan);
    const second = await (await call("/api/location", { ...address, longitude: 108.37 }, "POST", c)).json();
    assert.deepEqual(second.offers.xiaochan, []);
    assert.equal(second.updatedAt.xiaochan, undefined);
  });
  await test("raw Xiaochan response imports are rejected without modifying existing activities", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    for (const offers of [
      { status: { code: 0 }, feed_items: [] },
      { status: { code: 0 }, promotion_list: [] },
    ]) assert.equal((await call("/api/import", { provider: "xiaochan", offers }, "POST", c)).status, 400);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.offers.xiaochan[0].id, "xiaochan:001");
    assert.equal(saved.connections.xiaochan.state, "disconnected");
  });
  await test("Xiaochan synchronization uses the corrected nonce contract and preserves session isolation", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers
      .get("set-cookie")!
      .split(";")[0]!;
    await call(
      "/api/location",
      { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
      "POST",
      c,
    );
    await call(
      "/api/connections/xiaochan",
      {
        session:
          "x-teemo: 123456789\nx-vayne: 6789\nx-sivir: corrected-xiaochan-test-session\nx-version: 3.22.2.83",
      },
      "POST",
      c,
    );
    const response = await call("/api/sync", { provider: "xiaochan" }, "POST", c);
    assert.equal(response.status, 200);
    const text = await response.text(),
      result = JSON.parse(text);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.xiaochan.length, 1);
    assert.equal(result.data.offers.xiaochan[0].source, "live");
    assert.equal(result.data.connections.xiaochan.label, "会话可访问");
    assert.ok(!text.includes("corrected-xiaochan-test-session"));
    assert.equal(
      (await call("/api/sync", { provider: "xiaochan" }, "POST", c)).status,
      429,
    );
  });
  for (const [token, state, message] of [
    [
      "waf-xiaochan-test-session",
      "configured",
      "小蚕网关拦截，请检查网络连接",
    ],
    [
      "blocked-xiaochan-test-session",
      "configured",
      "小蚕拒绝同步请求",
    ],
    [
      "failed-xiaochan-test-session",
      "configured",
      "小蚕活动请求失败，请稍后重试",
    ],
    ["expired-xiaochan-test-session", "expired", "小蚕会话无效，请重新导入"],
  ]) {
    await test(`Xiaochan ${token} keeps the last dataset and classifies only confirmed expiry`, async () => {
      const c = (await fetch(base + "/api/dashboard")).headers
        .get("set-cookie")!
        .split(";")[0]!;
      await call(
        "/api/location",
        { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
        "POST",
        c,
      );
      await call(
        "/api/connections/xiaochan",
        { session: `x-teemo: 123456789\nx-vayne: 6789\nx-sivir: ${token}` },
        "POST",
        c,
      );
      await call(
        "/api/import",
        { provider: "xiaochan", offers: [row] },
        "POST",
        c,
      );
      const response = await call(
        "/api/sync",
        { provider: "xiaochan" },
        "POST",
        c,
      );
      assert.equal(response.status, 200);
      const text = await response.text(),
        result = JSON.parse(text);
      assert.deepEqual(result.errors, [message]);
      assert.equal(result.data.connections.xiaochan.state, state);
      assert.equal(result.data.offers.xiaochan[0].id, "xiaochan:001");
      assert.ok(!text.includes("private-upstream-field"));
      assert.ok(!text.includes(token!));
    });
  }
  await test("Xiaochan zero-identity session imports and syncs as guest without authenticating an account", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await call("/api/location", { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 }, "POST", c);
    const imported = await call("/api/connections/xiaochan", {
      session: JSON.stringify({ "x-teemo": "0", "x-vayne": "0", "x-session-id": "api-guest-canary", "x-version": "3.22.2.83" }),
    }, "POST", c);
    assert.equal(imported.status, 200);
    const configured = await imported.json();
    assert.equal(configured.connections.xiaochan.state, "configured");
    assert.equal(configured.connections.xiaochan.label, "访客待验证");
    assert.equal(configured.xiaochanHeaders, undefined);
    const response = await call("/api/sync", { provider: "xiaochan" }, "POST", c);
    assert.equal(response.status, 200);
    const text = await response.text(), result = JSON.parse(text);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.connections.xiaochan.state, "configured");
    assert.equal(result.data.connections.xiaochan.label, "访客访问");
    assert.equal(result.data.offers.xiaochan[0].source, "live");
    assert.equal(result.data.offers.xiaochan[0].id, "xiaochan:guest-offer");
    assert.equal(result.data.connections.meituan.state, "disconnected");
    assert.ok(!text.includes("api-guest-canary"));
    assert.equal((await call("/api/sync", { provider: "xiaochan" }, "POST", c)).status, 429);
    assert.equal((await call("/api/connections/xiaochan", { session: '{"x-teemo":"0","x-vayne":"2"}' }, "POST", c)).status, 400);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.connections.xiaochan.label, "访客访问");
    assert.equal(saved.offers.xiaochan.length, 1);
    assert.deepEqual((await (await fetch(base + "/api/dashboard", { headers: { cookie: cookie2 } })).json()).offers.xiaochan, []);
  });
  await test("failed Xiaochan guest sync preserves stored activities and does not mark the guest as authenticated", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await call("/api/location", { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 }, "POST", c);
    await call("/api/connections/xiaochan", { session: '{"x-teemo":"0","x-vayne":"0","x-session-id":"failed-guest-session"}' }, "POST", c);
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    const result = await (await call("/api/sync", { provider: "xiaochan" }, "POST", c)).json();
    assert.deepEqual(result.errors, ["小蚕返回 HTTP 503"]);
    assert.equal(result.data.offers.xiaochan[0].id, "xiaochan:001");
    assert.equal(result.data.connections.xiaochan.state, "configured");
    assert.equal(result.data.connections.xiaochan.label, "访客待验证");
  });
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
