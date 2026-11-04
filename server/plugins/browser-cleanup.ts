import { closeAllMeituan } from "../utils/meituan";

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("close", closeAllMeituan);
});
