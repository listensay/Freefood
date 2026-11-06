import { closeXiaochanSchedules, restoreXiaochanSchedules } from "../utils/xiaochan-schedules";

export default defineNitroPlugin(async nitro => {
  await restoreXiaochanSchedules();
  nitro.hooks.hook("close", closeXiaochanSchedules);
});
