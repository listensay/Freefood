import { sessionTestKey } from "./fixtures/session-key";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionDatabase } from "../server/utils/session-database";

const directory = await mkdtemp(join(tmpdir(), "food-desktop-"));
const token = randomBytes(32).toString("hex");
let child: ReturnType<typeof spawn> | undefined;
async function start() {
  child = spawn(process.execPath, ["dist/service/index.mjs"], { env: {
    ...process.env, FOOD_DATA_DIR: directory, FOOD_DESKTOP: "1", FOOD_SERVICE_TOKEN: token, PORT: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop service timeout: " + errors)), 10_000);
    child!.once("exit", () => { clearTimeout(timer); reject(new Error("Desktop service stopped: " + errors)); });
    child!.stdout!.on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); resolve(`http://127.0.0.1:${JSON.parse(output.split("\n")[0]!).port}`); }
    });
  });
  return base;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM"); await once(child, "exit");
}
let base = "";
const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: body === undefined ? "GET" : "POST", headers: {
    "x-food-desktop-token": token, "x-food-request": "1", "content-type": "application/json", origin: base, ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  base = await start();
  await test("Desktop APIs require the native capability and do not expose a browser UI or credentials", async () => {
    assert.equal((await fetch(base + "/api/dashboard")).status, 403);
    assert.equal((await call("/api/dashboard", undefined, { "x-food-desktop-token": "f".repeat(64) })).status, 403);
    assert.equal((await call("/api/dashboard", undefined, { origin: "https://example.com" })).status, 403);
    const response = await call("/api/dashboard"); assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.xiaochanAccount, undefined);
    assert.equal((await fetch(base + "/")).status, 404);
  });
  await test("Desktop data persists across native restarts without cookies or localStorage credentials", async () => {
    assert.equal((await call("/api/location", { label: "桌面地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 })).status, 200);
    const before = await (await call("/api/dashboard")).json();
    await stop(); base = await start();
    assert.equal((await (await call("/api/dashboard")).json()).location.label, "桌面地址");
    assert.deepEqual(await (await call("/api/dashboard")).json(), before);
    const names = await readdir(directory); assert.ok(names.includes("food.sqlite3"));
    assert.equal(names.includes("session.key"), false); assert.equal(names.some(name => name.endsWith(".enc")), false);
  });
  await test("Removed local-data endpoints cannot import or switch stored sessions", async () => {
    const db = await SessionDatabase.open(directory, async () => sessionTestKey);
    const selected = db.desktopId();
    const id = randomBytes(32).toString("hex");
    db.write(id, { location: { label: "独立地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 },
      connections: { xiaochan: { state: "disconnected", label: "未连接" }, waimai: { state: "disconnected", label: "未连接" }, meituan: { state: "disconnected", label: "未登录" } },
      offers: { xiaochan: [], waimai: [], meituan: [] }, updatedAt: {} }); db.close();
    assert.equal((await call("/api/desktop/profiles")).status, 404);
    assert.equal((await call("/api/desktop/import", { directory })).status, 404);
    assert.equal((await call("/api/desktop/select", { id })).status, 404);
    assert.equal((await call("/api/desktop/select", { id: "bad" })).status, 404);
    assert.equal((await (await call("/api/dashboard")).json()).location.label, "桌面地址");
    const stored = await SessionDatabase.open(directory, async () => sessionTestKey);
    try {
      assert.equal(stored.desktopId(), selected);
      assert.equal(stored.ids().length, 2);
      assert.equal(stored.read(id).location.label, "独立地址");
    } finally { stored.close(); }
  });
  await test("The Tauri package embeds the frontend and Node service with scoped local IPC", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    assert.equal(config.build.frontendDist, "../dist/client");
    assert.equal(config.bundle.resources["../dist/service/"], "service/");
    assert.deepEqual(config.bundle.externalBin, ["binaries/food-node"]);
    assert.equal(config.bundle.macOS.entitlements, "Entitlements.plist");
    assert.match(await readFile("src-tauri/Entitlements.plist", "utf8"), /com\.apple\.security\.cs\.allow-jit/);
    const capabilities = JSON.parse(await readFile("src-tauri/capabilities/main.json", "utf8"));
    assert.equal(capabilities.remote, undefined); assert.deepEqual(capabilities.windows, ["main"]);
    assert.ok(!capabilities.permissions.some((item: any) => typeof item === "string" && /shell|fs|sql/.test(item)));
    assert.doesNotMatch(await readFile("app/pages/accounts.vue", "utf8"), /DesktopData|本地数据|导入旧数据/);
    assert.doesNotMatch(await readFile("src-tauri/src/lib.rs", "utf8"), /import_legacy|tauri_plugin_dialog/);
  });
  await test("The desktop service exits and releases its database when the native parent disappears", async () => {
    const orphanDirectory = await mkdtemp(join(tmpdir(), "food-desktop-parent-"));
    const parent = spawn(process.execPath, ["--input-type=module", "-e", `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['dist/service/index.mjs'], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => console.log(child.pid));
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, FOOD_DATA_DIR: orphanDirectory, FOOD_DESKTOP: "1", FOOD_SERVICE_TOKEN: token, PORT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
    let servicePid: number | undefined;
    try {
      servicePid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Parent fixture did not start")), 10_000);
        parent.stdout!.once("data", bytes => { clearTimeout(timeout); resolve(Number(bytes.toString().trim())); });
        parent.once("exit", () => { clearTimeout(timeout); reject(new Error("Parent fixture exited")); });
      });
      assert.ok(Number.isSafeInteger(servicePid) && servicePid > 1);
      parent.kill("SIGTERM"); await once(parent, "exit");
      let alive = true;
      for (let i = 0; i < 80 && alive; i++) {
        try { process.kill(servicePid, 0); } catch (error: any) { if (error.code === "ESRCH") alive = false; }
        if (alive) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(alive, false, "An orphaned scheduler must not survive the native app");
      const db = await SessionDatabase.open(orphanDirectory, async () => sessionTestKey);
      try { db.acquireRuntimeLock(); } finally { db.close(); }
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGTERM");
      if (servicePid) try { process.kill(servicePid, "SIGTERM"); } catch {}
      await rm(orphanDirectory, { recursive: true, force: true });
    }
  });
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
