// https://nuxt.com/docs/api/configuration/nuxt-config
import { eventHandler } from "h3";
import { assertRequestAccess } from "./server/utils/request-access";

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  devServer: {
    host: process.env.FOOD_ALLOW_LAN === "1" ? "0.0.0.0" : "127.0.0.1",
  },
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "叠个饭 · 霸王餐与试吃官同店比价",
      meta: [
        {
          name: "description",
          content:
            "匹配小蚕、歪麦霸王餐与美团试吃官的同一家店，核验返现门槛，计算订单到手价。",
        },
      ],
      link: [
        { rel: "icon", href: "/favicon.ico", sizes: "any" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      ],
    },
  },
  nitro: {
    externals: { external: ["playwright-core"] },
    devHandlers: [{
      route: "/api",
      handler: eventHandler((event) => assertRequestAccess(event)),
    }],
  },
  vite: { ssr: { noExternal: [/\/shared\//] } },
});
