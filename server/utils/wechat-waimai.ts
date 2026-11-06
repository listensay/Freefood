import { createError } from "h3";
import type { AccountProfile } from "../../shared/types";
import { decodeWeChatStorage, readWeChatAppLogin } from "./wechat-storage";
import { verifyWaimaiAccount, type WaimaiAccount } from "./waimai";

export const WAIMAI_MINI_APP_ID = "wx5762f23d920ad9e5";

interface WeChatWaimaiLogin {
  account: WaimaiAccount;
}

export function decodeWeChatWaimaiStorage(main: Buffer, metadata: Buffer): WeChatWaimaiLogin {
  try {
    const values = decodeWeChatStorage(main, metadata, { appId: WAIMAI_MINI_APP_ID, name: "歪麦" },
      ["value", "token"]);
    const raw = values.get("value");
    const user = typeof raw === "string" ? JSON.parse(raw) : raw;
    const token = values.get("token");
    if (!user || typeof user !== "object" || Array.isArray(user) ||
      typeof user.userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(user.userId) ||
      typeof user.uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(user.uid) ||
      typeof token !== "string" || token.length > 16_000 || !/^[A-Za-z0-9._~+/=-]+$/.test(token) ||
      user.userToken !== token || user.application !== "overbear_one")
      throw createError({ statusCode: 401, statusMessage: "请先在电脑微信的歪麦小程序中登录" });
    return { account: { userId: user.userId, uid: user.uid, token } };
  } catch (error: any) {
    if (error.statusCode === 401) throw error;
    throw createError({ statusCode: 422, statusMessage: "微信歪麦存储格式无法识别，请更新连接工具" });
  }
}

export async function readWeChatWaimaiLogin(directory?: string): Promise<WeChatWaimaiLogin> {
  return readWeChatAppLogin({
    appId: WAIMAI_MINI_APP_ID,
    name: "歪麦",
    decode: decodeWeChatWaimaiStorage,
    identity: login => login.account.uid,
  }, directory);
}

export async function verifyWeChatWaimaiLogin(
  login: WeChatWaimaiLogin,
  verify: typeof verifyWaimaiAccount = verifyWaimaiAccount,
): Promise<{ account: WaimaiAccount; profile: AccountProfile; label: "已登录" }> {
  const profile = await verify(login.account);
  if (!profile || profile.userId !== login.account.uid)
    throw createError({ statusCode: 401, statusMessage: "歪麦账号验证失败，请在电脑微信中重新登录" });
  return { account: login.account, profile, label: "已登录" };
}
