import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { createEvent, sendError, type H3Error } from "h3";
import { assertRequestAccess } from "./server/utils/request-access.ts";

export default defineConfig({
  plugins: [vue(), tailwindcss(), {
    name: "food-local-api-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        // Validate the original TCP peer before Vite proxies to the private local service.
        const event = createEvent(req, res);
        try { assertRequestAccess(event); next(); }
        catch (error) { void sendError(event, error as H3Error); }
      });
    },
  }],
  resolve: { alias: { "#shared": fileURLToPath(new URL("./shared", import.meta.url)) } },
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    host: process.env.FOOD_ALLOW_LAN === "1" ? "0.0.0.0" : "127.0.0.1",
    port: Number(process.env.PORT || 1420), strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.FOOD_API_PORT || 1421}`, changeOrigin: false } },
    watch: { ignored: ["**/src-tauri/**", "**/.data/**", "**/dist/**"] },
  },
  clearScreen: false,
});
