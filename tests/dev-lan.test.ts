import "./fixtures/session-key";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { requestWithHost } from "./fixtures/http";

for (const lan of [false, true]) {
  await test(`Vite dev ${lan ? "LAN" : "local"} gateway enforces access before API proxying`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "food-dev-lan-"));
    const project = join(directory, "project");
    await mkdir(project);
    // Keep generated files and the dev lock separate from the user's running service.
    for (const name of ["app", "server", "shared", "public", "node_modules", "scripts"])
      await symlink(join(process.cwd(), name), join(project, name), "dir");
    for (const name of ["vite.config.ts", "package.json", "index.html", "tsconfig.json"])
      await copyFile(join(process.cwd(), name), join(project, name));
    const port = 40000 + Math.floor(Math.random() * 9000);
    const base = `http://127.0.0.1:${port}`;
    const host = `192.168.1.20:${port}`;
    const server = spawn(
      process.execPath,
      ["scripts/dev.mjs"],
      {
        cwd: project,
        env: {
          ...process.env,
          FOOD_ALLOW_LAN: lan ? "1" : "0",
          FOOD_DATA_DIR: directory,
          PORT: String(port),
        },
        stdio: "pipe",
      },
    );
    let output = "";
    for (const stream of [server.stdout, server.stderr])
      stream.on("data", (chunk) => {
        output += chunk.toString();
      });
    try {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        if (server.exitCode !== null) break;
        try {
          if ((await fetch(base + "/api/dashboard")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, `Dev API did not become ready: ${output}`);
      const response = await requestWithHost(base + "/api/dashboard", {
        headers: { host },
      });
      assert.equal(response.status, lan ? 200 : 403);
      {
        const mutationHost = lan ? host : `127.0.0.1:${port}`;
        const invalidImport = await requestWithHost(base + "/api/import", {
          method: "POST",
          headers: {
            host: mutationHost,
            origin: `http://${mutationHost}`,
            "x-food-request": "1",
            "content-type": "application/json",
          },
          body: "{}",
        });
        assert.equal(invalidImport.status, 400);
        assert.equal(
          (await invalidImport.json()).statusMessage,
          "请选择导入平台",
        );
      }
      const forgedHost = await requestWithHost(base + "/api/dashboard", {
        headers: {
          host: `8.8.8.8:${port}`,
          "x-forwarded-host": host,
          "x-forwarded-for": "192.168.1.21",
        },
      });
      assert.equal(forgedHost.status, 403);
      const crossSite = await requestWithHost(base + "/api/import", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "x-food-request": "1",
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(crossSite.status, 403);
    } finally {
      server.kill("SIGTERM");
      await Promise.race([
        once(server, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (server.exitCode === null) server.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
}
