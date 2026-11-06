import { createError } from "h3";
import type { AccountProfile } from "../../shared/types";
import { decodeWeChatStorage, readWeChatAppLogin } from "./wechat-storage";
import { safeUrl } from "../../shared/utils/import";
import { xiaochanAccountHeaders, xiaochanRpc, type XiaochanAccount } from "./xiaochan-rpc";

export const XIAOCHAN_MINI_APP_ID = "wx52ae177248081591";

interface WeChatLogin {
  account: XiaochanAccount;
}

function connectionError(statusCode: number, statusMessage: string) {
  return createError({ statusCode, statusMessage });
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): string | undefined {
  const text = String(value ?? "");
  return /^[1-9]\d{0,11}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : undefined;
}

function header(value: unknown, limit = 16_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit &&
    !/[\r\n\u0000]/.test(value);
}

export function decodeWeChatXiaochanStorage(main: Buffer, metadata: Buffer, now = Date.now()): WeChatLogin {
  try {
    const values = decodeWeChatStorage(main, metadata, { appId: XIAOCHAN_MINI_APP_ID, name: "小蚕" },
      ["store_user", "store_system", "baseUrl", "sessionId"]);
    for (const key of ["store_user", "store_system"]) {
      const value = values.get(key);
      if (typeof value === "string") values.set(key, JSON.parse(value));
    }
    const baseUrl = values.get("baseUrl");
    if (!header(baseUrl, 256)) throw new Error("Unexpected mini-program service");
    const service = new URL(baseUrl);
    if (service.origin !== "https://gw.xiaocantech.com" || service.username || service.password ||
      service.hash || service.search || !["/", "/rpc", "/g/pa"].includes(service.pathname))
      throw new Error("Unexpected mini-program service");
    const user = values.get("store_user");
    if (!record(user) || !record(user.userInfo) || !record(user.wechat_user_info) || !record(user.token))
      throw connectionError(401, "请先在电脑微信的小蚕小程序中登录");
    const silkId = positiveId(user.silkId), userId = positiveId(user.userInfo.user_id);
    if (!silkId || !userId || positiveId(user.userInfo.silk_id) !== silkId ||
      positiveId(user.wechat_user_info.user_id) !== userId || !header(user.token.access_token))
      throw connectionError(401, "请先在电脑微信的小蚕小程序中登录");
    const expiry = Number(user.token.expiry);
    if (!Number.isSafeInteger(expiry) || expiry <= 0 || !Number.isSafeInteger(expiry * 1000))
      throw new Error("Invalid token expiry");
    if (expiry * 1000 <= now)
      throw connectionError(401, "小蚕登录已失效，请在电脑微信中重新登录");
    const system = values.get("store_system");
    const model = record(system) && header(system.model, 100) && header(system.brand, 100)
      ? `${system.model} ${system.brand}` : undefined;
    const sessionId = values.get("sessionId");
    return {
      account: {
        silkId, userId, accessToken: user.token.access_token, expiresAt: expiry * 1000,
        ...(header(user.token.refresh_token) ? { refreshToken: user.token.refresh_token } : {}),
        platform: "mini",
        version: "3.22.2.83",
        ...(header(sessionId, 256) ? { sessionId } : {}),
        ...(model ? { model } : {}),
      },
    };
  } catch (error: any) {
    if (error.statusCode === 401) throw error;
    throw connectionError(422, "微信小蚕存储格式无法识别，请更新连接工具");
  }
}

export async function readWeChatXiaochanLogin(directory?: string): Promise<WeChatLogin> {
  return readWeChatAppLogin({
    appId: XIAOCHAN_MINI_APP_ID,
    name: "小蚕",
    decode: decodeWeChatXiaochanStorage,
    identity: login => login.account.userId,
    freshness: login => login.account.expiresAt!,
  }, directory);
}

export async function verifyWeChatXiaochanLogin(
  login: WeChatLogin,
  rpc: typeof xiaochanRpc = xiaochanRpc,
): Promise<{ account: XiaochanAccount; label: string; profile: AccountProfile }> {
  const account = login.account;
  const result = await rpc({
    headers: xiaochanAccountHeaders(account),
    serverName: "Silkworm",
    methodName: "SilkwormService.GetClientUserInfo",
    body: { silk_id: Number(account.silkId), user_id: Number(account.userId), app_id: 20 },
  });
  const user = result.user_info;
  if (!record(user) || positiveId(user.silk_id) !== account.silkId ||
    positiveId(user.user_id) !== account.userId || user.if_logoff === true)
    throw connectionError(401, "小蚕账号验证失败，请在电脑微信中重新登录");
  const nickname = typeof user.nickname === "string" && user.nickname.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(user.nickname) ? user.nickname.trim() : undefined;
  const phone = typeof user.phone === "string" && /^1[3-9]\d{9}$/.test(user.phone)
    ? `${user.phone.slice(0, 3)}****${user.phone.slice(-4)}`
    : typeof user.phone === "string" && /^1[3-9]\d\*{4}\d{4}$/.test(user.phone)
      ? user.phone : undefined;
  return { account, label: "已登录", profile: {
    userId: account.userId,
    ...(nickname ? { nickname } : {}),
    ...(safeUrl(user.avatar) ? { avatar: safeUrl(user.avatar) } : {}),
    ...(phone ? { phone } : {}),
  } };
}
