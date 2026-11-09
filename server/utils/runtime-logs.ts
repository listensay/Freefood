import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LogAction, LogExport, LogQuery, LogReason, LogSource, RuntimeLog } from "../../shared/runtime-logs";
import type { Provider } from "../../shared/types";
import { currentSessionDatabase, LOG_RETENTION_DAYS, MAX_LOG_ENTRIES, sessionDatabase } from "./session-database";
import { version } from "../../package.json";

interface LogContext {
  sessionId: string;
  traceId: string;
  action: LogAction;
  source: LogSource;
  provider?: Provider;
  page?: number;
  scheduledAt?: string;
}
const context = new AsyncLocalStorage<LogContext>();
const runId = randomUUID();
const runStartedAt = new Date().toISOString();
const sessions = new Map<string, { started: boolean; dropped: number }>();
const traffic = new Map<Provider, { last?: number; starts: number[]; active: number }>();
export const runtimeLogContext = () => context.getStore();

export function withLogContext<T>(fields: Partial<LogContext>, task: () => T): T {
  const parent = context.getStore();
  if (!parent && !fields.sessionId) return task();
  return context.run({ traceId: randomUUID(), action: "service", source: "system", ...parent, ...fields } as LogContext, task);
}

// Persist only explicitly selected metadata. Never store bodies, headers, raw errors or account identifiers.
function safeFields(fields: Partial<RuntimeLog>): Partial<RuntimeLog> {
  const safe: Partial<RuntimeLog> = {};
  for (const key of ["durationMs", "httpStatus", "businessCode", "retryAfterSeconds", "page", "rows", "offers", "gapMs", "inFlight", "requestsLastMinute"] as const) {
    const value = fields[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && (key === "businessCode" || value >= 0)) safe[key] = value;
  }
  if (typeof fields.hasMore === "boolean") safe.hasMore = fields.hasMore;
  if (fields.endpoint) {
    try {
      const url = new URL(fields.endpoint);
      if (["gw.xiaocantech.com", "fz-gateway.waimaimingtang.com", "wmapp-api-v2.waimaimingtang.com", "offsiteact.meituan.com", "passport.meituan.com"].includes(url.hostname) &&
        /^[a-zA-Z0-9/_.-]{1,180}$/.test(url.pathname)) safe.endpoint = url.origin + url.pathname;
    } catch { /* Unknown endpoints are omitted. */ }
  }
  if (fields.rpc && /^[A-Za-z][A-Za-z0-9_.]{0,120}$/.test(fields.rpc)) safe.rpc = fields.rpc;
  if (fields.clientVersion && /^\d+(?:\.\d+){1,4}$/.test(fields.clientVersion)) safe.clientVersion = fields.clientVersion;
  if (fields.client && ["mini", "Android", "browser"].includes(fields.client)) safe.client = fields.client;
  if (fields.method && ["GET", "POST"].includes(fields.method)) safe.method = fields.method;
  if (fields.contentType && ["json", "html", "other", "empty"].includes(fields.contentType)) safe.contentType = fields.contentType;
  for (const key of ["startedAt", "scheduledAt"] as const) {
    const value = fields[key];
    if (value && Number.isFinite(Date.parse(value))) safe[key] = new Date(value).toISOString();
  }
  return safe;
}

export function logFailureReason(error: any, httpStatus?: number): LogReason {
  const message = String(error?.statusMessage || error?.message || "");
  if (error?.data?.xiaochanFailure === "gateway-blocked" || /请求被拦截/.test(message)) return "gateway-blocked";
  if (httpStatus === 429 || error?.statusCode === 429 || /请求频繁|HTTP 429/.test(message)) return "rate-limited";
  if (httpStatus === 401 || error?.statusCode === 401 || /登录.*失效/.test(message)) return "login-expired";
  if (/安全验证|完成验证|captcha/i.test(message)) return "verification";
  if (httpStatus === 403 || error?.statusCode === 403 || /拒绝.*请求|拒绝访问/.test(message)) return "access-denied";
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || /超时(?!或)/.test(message)) return "timeout";
  if (/网络异常|fetch failed|ECONN|ENOTFOUND/i.test(message)) return "network";
  if (error instanceof SyntaxError || /内容异常|无法解析|结构|分页|未加载完整|Invalid .*key|Missing keys/.test(message)) return "invalid-response";
  if (/中断/.test(message)) return "interrupted";
  if ([400, 404, 409, 422].includes(error?.statusCode)) return "rejected";
  return "unknown";
}

export function logEvent(fields: Pick<RuntimeLog, "event" | "outcome"> & Partial<RuntimeLog>, logContext = context.getStore()) {
  const database = currentSessionDatabase();
  if (!logContext || !database) return;
  let state = sessions.get(logContext.sessionId);
  if (!state) { state = { started: false, dropped: 0 }; sessions.set(logContext.sessionId, state); }
  const write = (log: Omit<RuntimeLog, "id">) => {
    try { database.appendLog(logContext.sessionId, log); } catch { state!.dropped++; }
  };
  const base = { timestamp: new Date().toISOString(), runId, traceId: logContext.traceId,
    action: logContext.action, source: logContext.source, provider: fields.provider ?? logContext.provider };
  if (!state.started) {
    state.started = true;
    write({ ...base, timestamp: runStartedAt, provider: undefined, action: "service", source: "system", event: "service.start", level: "info", outcome: "success" });
  }
  write({ ...base, ...safeFields({ page: logContext.page, scheduledAt: logContext.scheduledAt, ...fields }),
    event: fields.event, outcome: fields.outcome,
    level: fields.level ?? (fields.outcome === "failure" ? "error" : "info"),
    ...(fields.reason ? { reason: fields.reason } : {}),
  });
}

export async function logOperation<T>(fields: Partial<LogContext>, task: () => Promise<T>): Promise<T> {
  return withLogContext(fields, async () => {
    const started = Date.now();
    logEvent({ event: "operation.start", outcome: "started" });
    try {
      const result = await task();
      const errors = (result as any)?.errors;
      const failed = Array.isArray(errors) && errors.length > 0;
      logEvent({ event: "operation.end", outcome: failed ? "failure" : "success", durationMs: Date.now() - started,
        ...(failed ? { reason: logFailureReason({ message: errors[0] }) } : {}),
        ...(Array.isArray((result as any)?.offers) ? { offers: (result as any).offers.length } : {}),
      });
      return result;
    } catch (error) {
      logEvent({ event: "operation.end", outcome: "failure", reason: logFailureReason(error), durationMs: Date.now() - started });
      throw error;
    }
  });
}

export function beginLoggedRequest(fields: Partial<RuntimeLog> & { provider: Provider }, logContext = context.getStore()) {
  const started = Date.now();
  let state = traffic.get(fields.provider);
  if (!state) { state = { starts: [], active: 0 }; traffic.set(fields.provider, state); }
  state.starts = state.starts.filter(time => time > started - 60_000);
  const metadata: Partial<RuntimeLog> = { ...fields, startedAt: new Date(started).toISOString(),
    gapMs: state.last === undefined ? undefined : started - state.last, inFlight: ++state.active,
    requestsLastMinute: state.starts.push(started) };
  state.last = started;
  let finished = false;
  let failure: LogReason | undefined;
  return {
    response(status: number, type: string | null, retryAfter?: string | null) {
      metadata.httpStatus = status;
      metadata.contentType = !type ? "empty" : /json/i.test(type) ? "json" : /html/i.test(type) ? "html" : "other";
      if (retryAfter) {
        const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
        if (Number.isSafeInteger(seconds)) metadata.retryAfterSeconds = Math.max(0, seconds);
      }
    },
    business(code: unknown) {
      if ((typeof code === "number" || typeof code === "string") && /^-?\d+$/.test(String(code))) metadata.businessCode = Number(code);
    },
    failure(error: unknown) { failure = logFailureReason(error, metadata.httpStatus); },
    end(error?: unknown) {
      if (finished) return;
      finished = true; state!.active--;
      const reason = failure ?? (error ? metadata.businessCode === 429 ? "rate-limited" : logFailureReason(error, metadata.httpStatus) : undefined);
      logEvent({ ...metadata, event: "request.end", outcome: error || reason ? "failure" : "success",
        reason, durationMs: Date.now() - started }, logContext);
    },
  };
}

export async function loggedRequest<T>(fields: Partial<RuntimeLog> & { provider: Provider }, task: (log: ReturnType<typeof beginLoggedRequest>) => Promise<T>) {
  const log = beginLoggedRequest(fields);
  try { const result = await task(log); log.end(); return result; }
  catch (error) { log.end(error); throw error; }
}

export async function queryRuntimeLogs(id: string, query: LogQuery = {}) {
  return { ...(await sessionDatabase()).queryLogs(id, query), droppedEvents: sessions.get(id)?.dropped ?? 0 };
}
export async function exportRuntimeLogs(id: string): Promise<LogExport> {
  return { format: "freefood-runtime-logs", formatVersion: 1, exportedAt: new Date().toISOString(), appVersion: version,
    runtime: process.version, platform: process.platform, architecture: process.arch, timezone: "UTC", displayTimezone: "Asia/Shanghai",
    retentionDays: LOG_RETENTION_DAYS, maxEntries: MAX_LOG_ENTRIES, droppedEvents: sessions.get(id)?.dropped ?? 0,
    entries: (await sessionDatabase()).queryLogs(id, {}, MAX_LOG_ENTRIES).entries.reverse() };
}
export async function clearRuntimeLogs(id: string) {
  (await sessionDatabase()).clearLogs(id);
  const state = sessions.get(id);
  if (state) state.dropped = 0;
}
