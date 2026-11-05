export { MEITUAN_LOGIN_URL } from "../../shared/meituan";

export type PassportIssue = "rejected" | "network" | "verification";

export function passportRequestIssue(
  status: number,
  data?: unknown,
): PassportIssue | undefined {
  if (status === 403 || status === 429) return "rejected";
  if (status < 200 || status >= 400) return "network";
  if (!data || typeof data !== "object") return "network";
  const error = (
    data as { error?: { message?: unknown; request_code?: unknown } }
  ).error;
  if (error?.request_code) return "verification";
  if (
    typeof error?.message === "string" &&
    /请求异常|拒绝操作|拒绝访问/.test(error.message)
  )
    return "rejected";
}

export function passportLoginIdentity(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return;
  const response = data as Record<string, any>;
  if (response.error) return;
  const user =
    response.user || (response.status === 1 ? response.data : undefined);
  if (!user || typeof user.token !== "string" || !user.token.trim()) return;
  const id = user.id ?? user.userId;
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    !/^\d+$/.test(String(id)) ||
    BigInt(String(id)) <= 0
  )
    return;
  return String(id);
}

export function activityAccessError(
  status: number,
  subject: "identity" | "page" | "offers",
): string {
  const label =
    subject === "identity"
      ? "美团身份接口"
      : subject === "page"
        ? "美团活动页面"
        : "美团活动接口";
  return status === 403
    ? `${label}拒绝访问，请稍后重试`
    : `${label}连接失败，请稍后重试`;
}
