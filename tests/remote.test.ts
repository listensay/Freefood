import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { writeChromeProfile } from "./fixtures/chrome-profile";

const directory = await mkdtemp(join(tmpdir(), "food-remote-"));
const chromeDirectory = await mkdtemp(join(tmpdir(), "food-remote-chrome-"));
const port = 49000 + Math.floor(Math.random() * 8000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [
    "--import",
    join(process.cwd(), "tests/fixtures/meituan-browser.mjs"),
    ".output/server/index.mjs",
  ],
  {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      FOOD_ALLOW_LAN: "0",
      FOOD_DATA_DIR: directory,
      FOOD_CHROME_DATA_DIR: chromeDirectory,
    },
    stdio: "pipe",
  },
);
let output = "";
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
const call = (path: string, cookie: string, token?: string, action?: unknown) =>
  fetch(base + path, {
    method: action === undefined ? "GET" : "POST",
    headers: {
      cookie,
      "x-food-request": "1",
      ...(token ? { "x-food-browser": token } : {}),
      "content-type": "application/json",
    },
    body: action === undefined ? undefined : JSON.stringify(action),
  });
const remote = "/api/connections/meituan/remote";
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
  assert.ok(ready, output);
  const cookie = (await fetch(base + "/api/dashboard")).headers
    .get("set-cookie")!
    .split(";")[0]!;
  const other = (await fetch(base + "/api/dashboard")).headers
    .get("set-cookie")!
    .split(";")[0]!;
  let token = "";
  await test("remote login starts headless and returns a per-session capability without browser credentials", async () => {
    const response = await call(
      "/api/connections/meituan/start",
      cookie,
      undefined,
      {},
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.match(data.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(data.viewport, { width: 480, height: 680 });
    assert.ok(Date.parse(data.expiresAt) > Date.now());
    token = data.token;
    assert.equal(data.storageState, undefined);
    const dashboard = await (await call("/api/dashboard", cookie)).json();
    assert.equal(dashboard.connections.meituan.state, "pending");
    assert.equal(dashboard.meituanStorage, undefined);
  });
  await test("remote frames are JPEG, uncached and inaccessible to another session or missing capability", async () => {
    const response = await call(remote + "/frame", cookie, token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const image = Buffer.from(await response.arrayBuffer());
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
    assert.equal((await call(remote + "/frame", cookie)).status, 403);
    assert.equal((await call(remote + "/frame", other, token)).status, 410);
    assert.equal(
      (await call(remote + "/frame", cookie, "a".repeat(64))).status,
      403,
    );
  });
  await test("verification before official login cannot save or authenticate a session", async () => {
    const response = await call(remote + "/verify", cookie, token, {});
    assert.equal(response.status, 401);
    const dashboard = await (await call("/api/dashboard", cookie)).json();
    assert.equal(dashboard.connections.meituan.state, "pending");
    assert.equal(dashboard.meituanStorage, undefined);
  });
  await test("remote input rejects arbitrary scripts, navigation and out-of-bounds coordinates", async () => {
    for (const action of [
      { type: "evaluate", script: "document.cookie" },
      { type: "goto", url: "http://localhost" },
      { type: "pointer", phase: "down", x: 480, y: 0 },
    ])
      assert.equal(
        (await call(remote + "/input", cookie, token, action)).status,
        400,
      );
    assert.equal(
      (await call(remote + "/input", other, token, { type: "reload" })).status,
      410,
    );
  });
  await test("reopening rotates the remote capability without discarding login progress", async () => {
    const previous = token;
    const data = await (
      await call("/api/connections/meituan/start", cookie, undefined, {})
    ).json();
    assert.notEqual(data.token, previous);
    token = data.token;
    assert.equal((await call(remote + "/frame", cookie, previous)).status, 403);
    assert.equal(
      (await call(remote + "/end", cookie, previous, {})).status,
      403,
    );
    assert.equal((await call(remote + "/frame", cookie, token)).status, 200);
  });
  await test("active remote sessions cannot control or capture each other's browser", async () => {
    const data = await (
      await call("/api/connections/meituan/start", other, undefined, {})
    ).json();
    assert.equal((await call(remote + "/frame", other, token)).status, 403);
    assert.equal(
      (await call(remote + "/input", cookie, data.token, { type: "reload" }))
        .status,
      403,
    );
    assert.equal(
      (await call(remote + "/end", other, data.token, {})).status,
      200,
    );
    assert.equal((await call(remote + "/frame", cookie, token)).status, 200);
  });
  const input = async (action: unknown) => {
    const response = await call(remote + "/input", cookie, token, action);
    assert.equal(response.status, 200, await response.text());
  };
  const click = async (x: number, y: number) => {
    await input({ type: "pointer", phase: "down", x, y });
    await input({ type: "pointer", phase: "up", x, y });
  };
  await test("official SMS refusal is surfaced as a safe status without authenticating or retrying", async () => {
    await click(400, 175);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const response = await call(remote + "/frame", cookie, token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-food-login-issue"), "rejected");
    const dashboard = await (await call("/api/dashboard", cookie)).text();
    assert.ok(!dashboard.includes("private-refusal-canary"));
    assert.equal(JSON.parse(dashboard).connections.meituan.state, "pending");
    assert.equal(
      (await call(remote + "/verify", cookie, token, {})).status,
      401,
    );
  });
  await test("remote pointer, keyboard, drag, iframe input and scrolling operate the official-page fixture", async () => {
    await input({ type: "reload" });
    await click(80, 175);
    await input({ type: "text", text: "13900000000" });
    await input({ type: "key", key: "ControlOrMeta+A" });
    await input({ type: "text", text: "13800000000" });
    await click(80, 240);
    await input({ type: "text", text: "123456" });
    await input({ type: "pointer", phase: "down", x: 44, y: 370 });
    await input({ type: "pointer", phase: "move", x: 180, y: 370 });
    await input({ type: "pointer", phase: "up", x: 180, y: 370 });
    await click(80, 310);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await input({ type: "wheel", deltaX: 0, deltaY: 100 });
  });
  await test("verification persists the browser session for sync and releases remote access", async () => {
    const response = await call(remote + "/verify", cookie, token, {});
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.connections.meituan.state, "connected");
    assert.equal(data.connections.meituan.label, "138****0000");
    assert.equal(data.meituanStorage, undefined);
    assert.equal((await call(remote + "/frame", cookie, token)).status, 410);
    await call("/api/location", cookie, undefined, {
      label: "测试地址",
      cityCode: 310000,
      latitude: 31.23,
      longitude: 121.47,
    });
    const sync = await (await call("/api/sync", cookie, undefined, {})).json();
    assert.deepEqual(sync.errors, []);
    assert.equal(sync.data.connections.meituan.state, "connected");
  });
  await test("closing a remote login revokes input and clears a pending connection", async () => {
    const data = await (
      await call("/api/connections/meituan/start", other, undefined, {})
    ).json();
    const response = await call(remote + "/end", other, data.token, {});
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).connections.meituan.state,
      "disconnected",
    );
    assert.equal(
      (await call(remote + "/input", other, data.token, { type: "reload" }))
        .status,
      410,
    );
  });
  await test("official account login survives blocked activity APIs without reporting the activities as connected", async () => {
    const started = await (
      await call("/api/connections/meituan/start", other, undefined, {})
    ).json();
    const action = async (data: unknown) => {
      const response = await call(
        remote + "/input",
        other,
        started.token,
        data,
      );
      assert.equal(response.status, 200, await response.text());
    };
    const point = async (x: number, y: number) => {
      await action({ type: "pointer", phase: "down", x, y });
      await action({ type: "pointer", phase: "up", x, y });
    };
    await point(80, 175);
    await action({ type: "text", text: "13900000000" });
    await point(80, 240);
    await action({ type: "text", text: "123456" });
    await action({ type: "pointer", phase: "down", x: 44, y: 370 });
    await action({ type: "pointer", phase: "move", x: 180, y: 370 });
    await action({ type: "pointer", phase: "up", x: 180, y: 370 });
    await point(80, 310);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const response = await call(remote + "/verify", other, started.token, {});
    assert.equal(response.status, 200, await response.clone().text());
    const dashboard = await response.json();
    assert.equal(dashboard.connections.meituan.state, "configured");
    assert.equal(
      dashboard.connections.meituan.message,
      "账号已登录，活动连接失败",
    );
    assert.equal(dashboard.meituanStorage, undefined);
    await call("/api/location", other, undefined, {
      label: "测试地址",
      cityCode: 310000,
      latitude: 31.23,
      longitude: 121.47,
    });
    const result = await (await call("/api/sync", other, undefined, {})).json();
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /拒绝访问/);
    assert.doesNotMatch(result.errors[0], /完成.*验证/);
    assert.equal(result.data.connections.meituan.state, "configured");
  });
  const chromeLogin = async (phone = "13800000000", profile = "Default") => writeChromeProfile(chromeDirectory, [
    { name: "remote-test-phone", value: phone }, { name: "token", value: `private-chrome-canary-${phone}` },
    { name: "unrelated", value: "private-foreign-canary", domain: "evil.example" },
  ], profile);
  await test("Chrome connects only after official identity verification and keeps credentials encrypted", async () => {
    const imported = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await chromeLogin();
    const response = await call("/api/connections/meituan/browser", imported, undefined, {});
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text(), result = JSON.parse(text);
    assert.equal(result.connections.meituan.state, "connected");
    assert.equal(result.connections.meituan.label, "138****0000");
    assert.ok(!text.includes("private-chrome-canary"));
    assert.ok(!text.includes("private-foreign-canary"));
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".enc")))
      assert.ok(!(await readFile(join(directory, name))).includes(Buffer.from("private-chrome-canary")));
    await call("/api/import", imported, undefined, { provider: "meituan", offers: [{ id: "keep", name: "已保存门店", rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 500 } }] });
    const reconnected = await call("/api/connections/meituan/browser", imported, undefined, {});
    assert.equal(reconnected.status, 200);
    assert.equal((await reconnected.json()).offers.meituan[0].id, "meituan:keep");
    await chromeLogin("13900000000");
    const failed = await call("/api/connections/meituan/browser", imported, undefined, {});
    assert.equal(failed.status, 502);
    const saved = await (await call("/api/dashboard", imported)).json();
    assert.equal(saved.connections.meituan.state, "connected");
    assert.equal(saved.offers.meituan[0].id, "meituan:keep");
    assert.equal((await call("/api/connections/meituan/browser", imported, undefined, { session: "cookie" })).status, 400);
    assert.equal((await call("/api/connections/meituan/session", imported, undefined, { session: "cookie" })).status, 404);
    await chromeLogin("13700000000");
    const switched = await call("/api/connections/meituan/browser", imported, undefined, {});
    assert.equal(switched.status, 200);
    assert.deepEqual((await switched.json()).offers.meituan, []);
    await chromeLogin("13800000000", "Profile 1");
    assert.equal((await call("/api/connections/meituan/browser", imported, undefined, {})).status, 409);
    await rm(join(chromeDirectory, "Profile 1"), { recursive: true, force: true });
    const owner = await (await call("/api/dashboard", cookie)).json();
    assert.equal(owner.connections.meituan.state, "connected");
  });
  await test("Meituan radius sync signs each page with the official SDK, keeps earlier pages and reads capped review bonuses", async () => {
    await fetch(base + "/api/connections/meituan", { method: "DELETE", headers: { cookie, "x-food-request": "1" } });
    const imported = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await chromeLogin("13600000000");
    assert.equal((await call("/api/connections/meituan/browser", imported, undefined, {})).status, 200);
    await call("/api/location", imported, undefined, { label: "测试地址", cityCode: 310000, latitude: 31.23, longitude: 121.47 });
    const response = await call("/api/sync", imported, undefined, { provider: "xiaochan" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.meituan.length, 2);
    assert.deepEqual(result.data.offers.meituan.map(offer => offer.distanceMeters), [1000, 7000]);
    assert.deepEqual(result.data.offers.meituan[0].reviewBonus, { ratioBps: 500, capCents: 100 });
    assert.equal(result.data.connections.meituan.state, "connected");
  });
  await test("Meituan pagination HTTP failures preserve saved activities and do not expose upstream response bodies", async () => {
    await fetch(base + "/api/connections/meituan", { method: "DELETE", headers: { cookie: other, "x-food-request": "1" } });
    const imported = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await chromeLogin("13500000000");
    assert.equal((await call("/api/connections/meituan/browser", imported, undefined, {})).status, 200);
    await call("/api/location", imported, undefined, { label: "测试地址", cityCode: 310000, latitude: 31.23, longitude: 121.47 });
    const existing = [{ id: "saved", name: "已保存门店", rule: { kind: "percentage", thresholdCents: 0, ratioBps: 3500, capCents: 1500 } }];
    const saved = await call("/api/import", imported, undefined, { provider: "meituan", offers: existing });
    assert.equal(saved.status, 200, await saved.clone().text());
    const response = await call("/api/sync", imported, undefined, { provider: "xiaochan" });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes("private-pagination-refusal-canary"));
    const result = JSON.parse(text);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /活动接口拒绝访问/);
    assert.equal(result.data.offers.meituan.length, 1);
    assert.equal(result.data.offers.meituan[0].id, "meituan:saved");
  });
} finally {
  server.kill("SIGTERM");
  const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
  await once(server, "exit").catch(() => {});
  clearTimeout(timeout);
  await rm(directory, { recursive: true, force: true });
  await rm(chromeDirectory, { recursive: true, force: true });
}
