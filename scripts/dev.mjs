import { spawn } from "node:child_process";
import { createServer } from "vite";
import { context } from "esbuild";
import { buildService, serviceOptions } from "./build.mjs";

await buildService();
const watcher = await context(serviceOptions); await watcher.watch();
const port = Number(process.env.PORT || 1420), apiPort = Number(process.env.FOOD_API_PORT || port + 1);
process.env.FOOD_API_PORT = String(apiPort);
const service = spawn(process.execPath, ["--watch", "--watch-path=dist/service/index.mjs", "dist/service/index.mjs"], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(apiPort) }, stdio: "inherit",
});
const vite = await createServer(); await vite.listen(); vite.printUrls();
let closing = false;
async function close() {
  if (closing) return; closing = true;
  service.kill("SIGTERM"); await vite.close(); await watcher.dispose();
  process.exit(0);
}
process.on("SIGTERM", close); process.on("SIGINT", close);
service.on("exit", code => { if (!closing) { process.exitCode = code || 1; void close(); } });
