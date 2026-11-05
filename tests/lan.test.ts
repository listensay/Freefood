import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { isAllowedHost } from "../server/utils/network";
import { requestWithHost } from "./fixtures/http";

const directory = await mkdtemp(join(tmpdir(), "food-lan-"));
const port = 30000 + Math.floor(Math.random() * 9000);
const base = `http://127.0.0.1:${port}`;
const host = `192.168.1.20:${port}`;
const origin = `http://${host}`;
const server = spawn(process.execPath, [".output/server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "0.0.0.0",
    PORT: String(port),
    FOOD_ALLOW_LAN: "1",
    FOOD_DATA_DIR: directory,
  },
  stdio: "pipe",
});
let output = "";
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
const call = (path: string, init: RequestInit = {}) =>
  requestWithHost(base + path, {
    ...init,
    headers: { host, ...Object.fromEntries(new Headers(init.headers)) },
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
  assert.ok(ready, `LAN server failed to start: ${output}`);
  const init = await call("/api/dashboard");
  const cookie = init.headers.get("set-cookie")!.split(";")[0]!;

  await test("LAN mode serves private-host APIs and issues isolated HTTP session cookies", async () => {
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("cache-control"), "no-store");
    assert.match(init.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(init.headers.get("set-cookie")!, /SameSite=Strict/);
    assert.doesNotMatch(init.headers.get("set-cookie")!, /; Secure/);
    const data = await init.json();
    assert.equal(data.xiaochanHeaders, undefined);
    assert.equal(data.waimaiToken, undefined);
  });

  await test("LAN same-origin mutations work and do not authenticate imported offers", async () => {
    const response = await call("/api/import", {
      method: "POST",
      headers: {
        origin,
        cookie,
        "x-food-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "waimai",
        offers: [
          {
            id: "lan-test",
            name: "局域网测试",
            rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 2000 },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.offers.waimai.length, 1);
    assert.equal(data.connections.waimai.state, "disconnected");
    const isolated = await (await call("/api/dashboard")).json();
    assert.deepEqual(isolated.offers.waimai, []);
  });

  await test("LAN mode rejects public hosts and does not trust forwarding headers", async () => {
    for (const hostname of ["evil.example", "8.8.8.8"])
      assert.equal(
        (
          await call("/api/dashboard", {
            headers: { host: `${hostname}:${port}`, "x-forwarded-host": host },
          })
        ).status,
        403,
      );
    const request = await call("/api/dashboard", {
      headers: { origin, "x-forwarded-proto": "https" },
    });
    assert.equal(request.status, 200);
    assert.doesNotMatch(request.headers.get("set-cookie")!, /; Secure/);
  });

  await test("LAN mode continues to reject cross-site and unvalidated mutations", async () => {
    const headers = {
      cookie,
      origin,
      "x-food-request": "1",
      "content-type": "application/json",
    };
    for (const extra of [
      { origin: "https://evil.example" },
      { origin: `http://192.168.1.20:${port + 1}` },
      { "sec-fetch-site": "cross-site" },
      { "x-food-request": "" },
    ])
      assert.equal(
        (
          await call("/api/import", {
            method: "POST",
            headers: { ...headers, ...extra },
            body: "{}",
          })
        ).status,
        403,
      );
  });

  const address = Object.values(networkInterfaces())
    .flat()
    .find(
      (item) =>
        item &&
        item.family === "IPv4" &&
        !item.internal &&
        isAllowedHost(item.address, true),
    )?.address;
  await test(
    "LAN server is reachable through the computer's actual private interface",
    { skip: !address },
    async () => {
      const response = await fetch(`http://${address}:${port}/api/dashboard`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("set-cookie"));
    },
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
