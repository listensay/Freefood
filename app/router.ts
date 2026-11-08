import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { isTauri } from "@tauri-apps/api/core";
import Home from "./pages/index.vue";
import Accounts from "./pages/accounts.vue";
import Guide from "./pages/guide.vue";
import NotFound from "./pages/not-found.vue";

export const router = createRouter({
  history: isTauri() ? createWebHashHistory() : createWebHistory(),
  routes: [
    { path: "/", component: Home, meta: { title: "叠个饭 · 霸王餐与试吃官同店比价" } },
    { path: "/accounts", component: Accounts, meta: { title: "账号管理 · 叠个饭" } },
    { path: "/guide", component: Guide, meta: { title: "使用指南 · 叠个饭" } },
    { path: "/:pathMatch(.*)*", component: NotFound, meta: { title: "页面不存在 · 叠个饭" } },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
router.afterEach(to => { document.title = String(to.meta.title); });
