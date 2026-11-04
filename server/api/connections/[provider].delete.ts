import { disconnectPlatform } from "../../utils/connections";
import { assertLocalRequest } from "../../utils/session";

export default defineEventHandler(async (event) => {
  assertLocalRequest(event);
  const provider = getRouterParam(event, "provider");
  if (provider !== "xiaochan" && provider !== "meituan")
    throw createError({ statusCode: 400, statusMessage: "未知平台" });
  return disconnectPlatform(event, provider);
});
