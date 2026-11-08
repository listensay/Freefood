import { createApp } from "vue";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import App from "./app.vue";
import { router } from "./router";
import "./assets/css/main.css";

if (isTauri()) document.addEventListener("click", event => {
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!link) return;
  const url = new URL(link.href, location.href);
  if (["https:", "http:"].includes(url.protocol) && url.origin !== location.origin) {
    event.preventDefault();
    void openUrl(url.href).catch(() => {});
  }
});
const app = createApp(App).use(router);
// Resolve the initial route before mounting so only later page changes animate.
void router.isReady().then(() => app.mount("#app"));
