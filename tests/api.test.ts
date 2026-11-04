import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const directory = await mkdtemp(join(tmpdir(), "food-api-"));
const port = 19000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [".output/server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
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
    assert.equal(data.meituanStorage, undefined);
    assert.equal(data.location, null);
    assert.deepEqual(data.offers, { xiaochan: [], meituan: [] });
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
  await test("different browser sessions never share credentials or imported offers", async () => {
    const r = await fetch(base + "/api/dashboard", {
      headers: { cookie: cookie2 },
    });
    const d = await r.json();
    assert.equal(d.offers.xiaochan.length, 0);
    assert.equal(d.connections.xiaochan.state, "disconnected");
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
      latitude: 31.23,
      longitude: 121.47,
    });
    const d = await r.json();
    assert.equal(d.offers.xiaochan.length, 0);
    assert.equal(d.offers.meituan.length, 0);
    assert.equal(d.connections.xiaochan.state, "configured");
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
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
