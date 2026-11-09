import { defineEventHandler, readBody, createError, setHeader } from "h3";
import { providers } from "../../../shared/types";
import { logReasons, type LogQuery } from "../../../shared/runtime-logs";
import { sessionId } from "../../utils/session";
import { queryRuntimeLogs } from "../../utils/runtime-logs";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event) ?? {};
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    (body.before !== undefined && (!Number.isSafeInteger(body.before) || body.before < 1)) ||
    (body.provider !== undefined && !providers.includes(body.provider)) ||
    (body.level !== undefined && !["info", "warn", "error"].includes(body.level)) ||
    (body.reason !== undefined && (typeof body.reason !== "string" || !Object.hasOwn(logReasons, body.reason))))
    throw createError({ statusCode: 400, statusMessage: "日志筛选条件无效" });
  const query: LogQuery = { before: body.before, provider: body.provider, level: body.level, reason: body.reason };
  setHeader(event, "Cache-Control", "no-store");
  return queryRuntimeLogs(id, query);
});
