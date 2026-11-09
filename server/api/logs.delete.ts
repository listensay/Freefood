import { defineEventHandler, setHeader } from "h3";
import { sessionId } from "../utils/session";
import { clearRuntimeLogs } from "../utils/runtime-logs";

export default defineEventHandler(async event => {
  await clearRuntimeLogs(sessionId(event));
  setHeader(event, "Cache-Control", "no-store");
  return { cleared: true };
});
