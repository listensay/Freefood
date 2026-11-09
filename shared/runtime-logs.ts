import type { Provider } from "./types";

export const logActions = {
  service: "本地服务", sync: "同步活动", connect: "连接账号", profile: "查询账号", disconnect: "断开账号",
  enroll: "报名", cancel: "取消报名", schedule: "预约报名", "cancel-schedule": "取消预约", coupons: "查询卡券",
  location: "更新地址", import: "导入活动", verify: "验证登录",
} as const;
export const logSources = { manual: "手动", automatic: "自动", schedule: "预约", system: "系统" } as const;
export const logReasons = {
  "gateway-blocked": "网关拦截", "access-denied": "访问被拒绝", "rate-limited": "请求频繁", "login-expired": "登录失效",
  verification: "需要验证", timeout: "请求超时", network: "网络异常", "invalid-response": "响应异常",
  rejected: "操作被拒绝", interrupted: "执行中断", unknown: "操作失败",
} as const;
export type LogAction = keyof typeof logActions;
export type LogSource = keyof typeof logSources;
export type LogReason = keyof typeof logReasons;
export type LogLevel = "info" | "warn" | "error";
export interface RuntimeLog {
  id: number;
  timestamp: string;
  runId: string;
  traceId: string;
  event: "service.start" | "operation.start" | "operation.end" | "request.end" | "page.end" | "schedule.restored";
  action: LogAction;
  source: LogSource;
  provider?: Provider;
  level: LogLevel;
  outcome: "started" | "success" | "failure";
  reason?: LogReason;
  startedAt?: string;
  durationMs?: number;
  endpoint?: string;
  method?: "GET" | "POST";
  rpc?: string;
  client?: "mini" | "Android" | "browser";
  clientVersion?: string;
  httpStatus?: number;
  businessCode?: number;
  contentType?: "json" | "html" | "other" | "empty";
  retryAfterSeconds?: number;
  page?: number;
  rows?: number;
  offers?: number;
  hasMore?: boolean;
  gapMs?: number;
  inFlight?: number;
  requestsLastMinute?: number;
  scheduledAt?: string;
}
export interface LogQuery { before?: number; provider?: Provider; level?: LogLevel; reason?: LogReason; }
export interface LogPage {
  entries: RuntimeLog[];
  total: number;
  nextCursor?: number;
  droppedEvents: number;
}
export interface LogExport {
  format: "freefood-runtime-logs";
  formatVersion: 1;
  exportedAt: string;
  appVersion: string;
  runtime: string;
  platform: string;
  architecture: string;
  timezone: "UTC";
  displayTimezone: "Asia/Shanghai";
  retentionDays: number;
  maxEntries: number;
  droppedEvents: number;
  entries: RuntimeLog[];
}
export function logSummary(log: RuntimeLog): string {
  if (log.reason) return logReasons[log.reason];
  if (log.event === "service.start") return "服务已启动";
  if (log.event === "schedule.restored") return "预约已恢复";
  if (log.event === "page.end") return `第 ${log.page} 页 · ${log.rows} 条`;
  if (log.event === "request.end") return log.outcome === "success" ? "请求成功" : "请求失败";
  return `${logActions[log.action]}${log.outcome === "started" ? "开始" : log.outcome === "success" ? "完成" : "失败"}`;
}
