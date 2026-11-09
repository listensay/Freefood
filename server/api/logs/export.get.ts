import { defineEventHandler, setHeader } from "h3";
import { sessionId } from "../../utils/session";
import { exportRuntimeLogs } from "../../utils/runtime-logs";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  setHeader(event, "Cache-Control", "no-store");
  return exportRuntimeLogs(id);
});
