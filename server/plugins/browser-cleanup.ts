import { closeAllMeituan, closeIdleMeituan } from "../utils/meituan";

export default defineNitroPlugin((nitro) => {
  const timer = setInterval(() => {
    void closeIdleMeituan().catch(() => {});
  }, 60_000);
  timer.unref();
  nitro.hooks.hook("close", async () => {
    clearInterval(timer);
    await closeAllMeituan();
  });
});
