import { build as buildClient } from "vite";
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

export const serviceOptions = {
  entryPoints: ["server/index.ts"], outfile: "dist/service/index.mjs",
  bundle: true, platform: "node", target: "node24", format: "esm",
  external: ["playwright-core"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
};
export async function buildService() {
  await build(serviceOptions);
  await mkdir("dist/service/node_modules", { recursive: true });
  await rm("dist/service/node_modules/playwright-core", { recursive: true, force: true });
  await cp("node_modules/playwright-core", "dist/service/node_modules/playwright-core", { recursive: true });
}
if (process.argv[1]?.endsWith("scripts/build.mjs")) {
  await buildClient();
  await buildService();
}
