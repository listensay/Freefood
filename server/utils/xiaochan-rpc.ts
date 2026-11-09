import { loggedRequest } from "./runtime-logs";
import { createHash, randomUUID } from "node:crypto";
import { createError } from "h3";
import type { LocationSettings } from "../../shared/types";

export interface XiaochanAccount {
  silkId: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  platform?: "Android" | "mini";
  version?: string;
  sessionId?: string;
  sessionIdExpiresAt?: number;
  model?: string;
}

interface XiaochanRpcRequest {
  headers: Record<string, string>;
  serverName: string;
  methodName: string;
  body: Record<string, unknown>;
  location?: LocationSettings | null;
}

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

export function decodeXiaochanSession(
  value: unknown,
  expiresAt?: number,
  now = Date.now(),
): Pick<XiaochanAccount, "sessionId" | "sessionIdExpiresAt"> | undefined {
  if (typeof value !== "string") return;
  if (value.trimStart().startsWith("{")) {
    try {
      const cache = JSON.parse(value);
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) return;
      value = cache.value;
      if (cache.expire !== undefined && cache.expire !== null && cache.expire !== "" && cache.expire !== 0) {
        const seconds = Number(cache.expire);
        if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000)) return;
        expiresAt = seconds * 1000;
      }
    } catch {
      return;
    }
  }
  if (typeof value !== "string" || !value || value.length > 256 ||
    value.trim() !== value || /[\r\n\u0000{}\[\]]/.test(value) ||
    (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))) return;
  return { sessionId: value, ...(expiresAt !== undefined ? { sessionIdExpiresAt: expiresAt } : {}) };
}

const generatedSessions = new Map<string, { id: string; expiresAt: number }>();

function requestSessionId(account: XiaochanAccount): string {
  const now = Date.now();
  // Older saved accounts contain the serialized WeChat cache entry, not its value.
  const saved = decodeXiaochanSession(account.sessionId, account.sessionIdExpiresAt, now);
  if (saved?.sessionId) return saved.sessionId;
  const key = createHash("sha256").update(JSON.stringify([
    account.platform || "Android", account.silkId, account.userId, account.accessToken,
  ])).digest("hex");
  const current = generatedSessions.get(key);
  if (current && current.expiresAt > now) return current.id;
  for (const [key, session] of generatedSessions)
    if (session.expiresAt <= now) generatedSessions.delete(key);
  if (generatedSessions.size >= 100) generatedSessions.delete(generatedSessions.keys().next().value!);
  // The mini-program stores a newly generated session for 1,800 seconds.
  const session = { id: randomUUID(), expiresAt: now + 30 * 60_000 };
  generatedSessions.set(key, session);
  return session.id;
}

export function xiaochanAccountHeaders(account: XiaochanAccount): Record<string, string> {
  if (!account || typeof account.silkId !== "string" || !/^[1-9]\d{0,11}$/.test(account.silkId) ||
    typeof account.userId !== "string" || !/^[1-9]\d*$/.test(account.userId) || !Number.isSafeInteger(Number(account.userId)) ||
    typeof account.accessToken !== "string" || !account.accessToken || account.accessToken.length > 16_000 ||
    /[\r\n\u0000]/.test(account.accessToken) ||
    (account.expiresAt !== undefined && account.expiresAt <= Date.now()))
    throw createError({ statusCode: 401, statusMessage: "小蚕登录已失效，请重新登录" });
  if (account.platform === "mini") return {
    "x-teemo": account.silkId,
    "x-vayne": account.userId,
    "x-sivir": account.accessToken,
    "x-platform": "mini",
    "x-annie": "XC",
    "x-version": account.version || "3.22.2.83",
    "x-app-sr": "20",
    "x-session-id": requestSessionId(account),
    ...(account.model ? { "x-model": account.model } : {}),
    referer: "https://servicewechat.com/wx52ae177248081591/814/page-frame.html",
    "user-agent": "Mozilla/5.0 MicroMessenger/7.0.20.1781 MacWechat/3.8.7",
    xweb_xhr: "1",
  };
  return {
    "x-teemo": account.silkId,
    "x-vayne": account.userId,
    "x-sivir": account.accessToken,
    "x-platform": "Android",
    "x-annie": "XC",
    "x-version": "3.22.2.5",
    "x-app-sr": "16",
    "x-channel": "xiaocan",
    "x-session-id": requestSessionId(account),
    "user-agent": "XC;Android;3.22.2;",
  };
}

export function xiaochanRequestHeaders(
  headers: Record<string, string>,
  serverName: string,
  methodName: string,
  location?: LocationSettings | null,
): Record<string, string> {
  const timestamp = String(Date.now());
  const identity = headers["x-teemo"] || "";
  const uuid = randomUUID().replaceAll("-", "");
  if (!/^[1-9]\d{0,11}$/.test(identity) || !/^[1-9]\d*$/.test(headers["x-vayne"] || "") ||
    !headers["x-sivir"])
    throw createError({ statusCode: 401, statusMessage: "小蚕登录已失效，请重新登录" });
  const native = headers["x-platform"] === "Android";
  const randomLength = 16 - identity.length;
  const middle = Math.floor(randomLength / 2);
  const nonce = native
    ? `${uuid.slice(0, middle)}${identity}${uuid.slice(middle, randomLength)}`
    : `${uuid.slice(0, 4)}${identity}${uuid.slice(4, 16 - identity.length)}`;
  const version = headers["x-version"] || headers.version || (native ? "3.22.2.5" : "3.21.7.82");
  const { version: _legacyVersion, ...requestHeaders } = headers;
  return {
    ...requestHeaders,
    serverName,
    methodName,
    ...(native ? {} : { version }),
    "x-version": version,
    "x-nami": nonce,
    "x-garen": timestamp,
    "x-ashe": md5(md5(`${serverName}.${methodName}`.toLowerCase()) + timestamp + nonce),
    ...(location ? { "x-city": String(location.cityCode), "x-citycode": String(location.cityCode) } : {}),
    "content-type": "application/json",
  };
}

function rpcError(statusCode: number, statusMessage: string, rejected: boolean, gatewayBlocked = false) {
  return createError({
    statusCode,
    statusMessage,
    data: {
      xiaochanOutcome: rejected ? "rejected" : "unknown",
      ...(gatewayBlocked ? { xiaochanFailure: "gateway-blocked" } : {}),
    },
  });
}

export async function isXiaochanGatewayBlock(response: Response): Promise<boolean> {
  if (
    response.status !== 403 ||
    !response.headers.get("content-type")?.toLowerCase().includes("text/html") ||
    !response.body
  )
    return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64_000) return false;
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString("utf8");
    return /WAF拦截页面/.test(html) && /腾讯云\s*WAF/i.test(html);
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function xiaochanRpc(
  request: XiaochanRpcRequest,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, any>> {
  return loggedRequest({ provider: "xiaochan", endpoint: "https://gw.xiaocantech.com/rpc", method: "POST",
    rpc: `${request.serverName}.${request.methodName}`, client: request.headers["x-platform"] as "mini" | "Android", clientVersion: request.headers["x-version"] }, async log => {
    let response: Response;
    try {
      // /g/pa is the App bootstrap endpoint; business RPCs use /rpc.
      response = await fetcher("https://gw.xiaocantech.com/rpc", {
        method: "POST",
        headers: xiaochanRequestHeaders(request.headers, request.serverName, request.methodName, request.location),
        body: JSON.stringify(request.headers["x-platform"] === "mini"
          ? { ...request.body, app_id: 20 } : request.body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log.failure(error);
      throw rpcError(502, "小蚕连接超时或网络异常，请稍后重试", false);
    }
    log.response(response.status, response.headers.get("content-type"), response.headers.get("retry-after"));
    if (!response.ok) {
      const gatewayBlocked = await isXiaochanGatewayBlock(response);
      throw rpcError(
        response.status === 401 ? 401 : response.status === 429 ? 429 : 502,
        response.status === 401 ? "小蚕登录已失效，请重新登录"
          : response.status === 429 ? "小蚕请求频繁，请稍后重试"
            : gatewayBlocked ? "小蚕请求被拦截，请稍后重试"
              : "小蚕请求失败，请稍后重试",
        response.status >= 400 && response.status < 500,
        gatewayBlocked,
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw rpcError(502, "小蚕返回内容异常，请稍后重试", false);
    }
    log.business(data?.status?.code);
    if (!data || !data.status || !/^\d+$/.test(String(data.status.code)))
      throw rpcError(502, "小蚕返回内容异常，请稍后重试", false);
    if (Number(data.status.code) !== 0) {
      const message = typeof data.status.msg === "string" ? data.status.msg : "";
      const expired = Number(data.status.code) === 401 ||
        /未登录|登录(?:已)?(?:过期|失效)|会话(?:已)?(?:过期|失效)|token.{0,8}expired|unauthenticated|not logged in/i.test(message);
      const captcha = Number(data.status.code) === 200001 || /人机|滑块|captcha|ticket|安全验证/i.test(message);
      throw rpcError(
        expired ? 401 : captcha ? 422 : Number(data.status.code) === 429 ? 429 : 400,
        expired ? "小蚕登录已失效，请重新登录"
          : captcha ? "请在小蚕完成安全验证后重试"
            : Number(data.status.code) === 429 ? "小蚕请求频繁，请稍后重试"
              : "小蚕操作失败，请检查账号或活动状态",
        true,
      );
    }
    return data;
  });
}
