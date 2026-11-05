import { disconnectPlatform } from "../../utils/connections";
import { assertLocalRequest } from "../../utils/session";
import { providers, type Provider } from "../../../shared/types";

export default defineEventHandler(async (event) => {
  assertLocalRequest(event);
  const provider = getRouterParam(event, "provider");
  if (!providers.includes(provider as Provider))
    throw createError({ statusCode: 400, statusMessage: "未知平台" });
  return disconnectPlatform(event, provider as Provider);
});
