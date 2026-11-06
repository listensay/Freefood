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
    "x-session-id": account.sessionId || randomUUID(),
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
    "x-session-id": randomUUID(),
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
  return {
    ...headers,
    serverName,
    methodName,
    version,
    "x-version": version,
    "x-nami": nonce,
    "x-garen": timestamp,
    "x-ashe": md5(md5(`${serverName}.${methodName}`.toLowerCase()) + timestamp + nonce),
    ...(location ? { "x-city": String(location.cityCode), "x-citycode": String(location.cityCode) } : {}),
    "content-type": "application/json",
  };
}

function rpcError(statusCode: number, statusMessage: string, rejected: boolean) {
  return createError({
    statusCode,
    statusMessage,
    data: { xiaochanOutcome: rejected ? "rejected" : "unknown" },
  });
}

export async function xiaochanRpc(
  request: XiaochanRpcRequest,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetcher(request.headers["x-platform"] === "Android"
      ? "https://gw.xiaocantech.com/g/pa" : "https://gw.xiaocantech.com/rpc", {
      method: "POST",
      headers: xiaochanRequestHeaders(request.headers, request.serverName, request.methodName, request.location),
      body: JSON.stringify(request.headers["x-platform"] === "mini"
        ? { ...request.body, app_id: 20 } : request.body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw rpcError(502, "小蚕连接超时或网络异常，请稍后重试", false);
  }
  if (!response.ok) {
    throw rpcError(
      response.status === 401 ? 401 : response.status === 429 ? 429 : 502,
      response.status === 401 ? "小蚕登录已失效，请重新登录"
        : response.status === 429 ? "小蚕请求频繁，请稍后重试"
          : "小蚕请求失败，请稍后重试",
      response.status >= 400 && response.status < 500,
    );
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw rpcError(502, "小蚕返回内容异常，请稍后重试", false);
  }
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
}
