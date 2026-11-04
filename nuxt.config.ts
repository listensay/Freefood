// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "叠个饭 · 霸王餐与试吃官同店比价",
      meta: [
        {
          name: "description",
          content:
            "匹配小蚕霸王餐与美团试吃官的同一家店，核验返现门槛，计算订单到手价。",
        },
      ],
    },
  },
  nitro: { externals: { external: ["playwright-core"] } },
  vite: { ssr: { noExternal: [/\/shared\//] } },
});
