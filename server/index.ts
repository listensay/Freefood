import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";
import { createApp, createError, eventHandler, setHeader, toNodeListener } from "h3";
import { apiRouter } from "./routes";
import { assertRequestAccess } from "./utils/request-access";
import { closeSessionDatabase, sessionDatabase } from "./utils/session-database";
import { closeAllMeituan, closeIdleMeituan } from "./utils/meituan";
import { restoreXiaochanSchedules, closeXiaochanSchedules } from "./utils/xiaochan-schedules";
import { restoreWaimaiSchedules, closeWaimaiSchedules } from "./utils/waimai-schedules";

const desktop = process.env.FOOD_DESKTOP === "1";
const parentPid = process.ppid;
if (desktop && !/^[a-f0-9]{64}$/.test(process.env.FOOD_SERVICE_TOKEN || "")) throw new Error("Missing desktop service token");
(await sessionDatabase()).acquireRuntimeLock();
await restoreXiaochanSchedules();
await restoreWaimaiSchedules();
const app = createApp({ debug: false });
app.use(eventHandler(event => {
  if (event.path.startsWith("/api/")) assertRequestAccess(event);
}));
app.use(apiRouter().handler);
const root = resolve(process.env.FOOD_CLIENT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../client"));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };
app.use(eventHandler(async event => {
  if (desktop || !["GET", "HEAD"].includes(event.method)) throw createError({ statusCode: 404 });
  let path: string;
  try { path = decodeURIComponent(event.path.split("?")[0]!); } catch { throw createError({ statusCode: 400 }); }
  if (["/", "/accounts", "/guide", "/logs"].includes(path)) path = "/index.html";
  const file = resolve(root, "." + path);
  if (!file.startsWith(root + sep) || path.includes("\\") || path.includes("\0")) throw createError({ statusCode: 404 });
  try {
    const bytes = await readFile(file);
    setHeader(event, "Content-Type", types[extname(file)] || "application/octet-stream");
    setHeader(event, "X-Content-Type-Options", "nosniff");
    return bytes;
  } catch { throw createError({ statusCode: 404 }); }
}));
const server = createServer(toNodeListener(app));
const timer = setInterval(() => { void closeIdleMeituan().catch(() => {}); }, 60_000);
timer.unref();
// A forced native-app exit must not leave an invisible scheduler or block the next launch.
const parentTimer = desktop ? setInterval(() => {
  if (process.ppid !== parentPid) void shutdown();
}, 1000) : undefined;
parentTimer?.unref();
const host = desktop ? "127.0.0.1" : process.env.HOST || (process.env.FOOD_ALLOW_LAN === "1" ? "0.0.0.0" : "127.0.0.1");
server.listen(Number(process.env.PORT || (desktop ? 0 : 3000)), host, () => {
  const address = server.address();
  if (address && typeof address !== "string") process.stdout.write(JSON.stringify({ type: "ready", port: address.port }) + "\n");
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true; clearInterval(timer); clearInterval(parentTimer); closeXiaochanSchedules(); closeWaimaiSchedules();
  const fallback = setTimeout(() => process.exit(1), 5000); fallback.unref();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), closeAllMeituan()]);
  closeSessionDatabase(); process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
