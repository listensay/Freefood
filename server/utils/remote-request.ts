import { createError, getHeader, type H3Event } from "h3";

export function remoteToken(event: H3Event): string {
  const token = getHeader(event, "x-food-browser") || "";
  if (!/^[a-f0-9]{64}$/.test(token))
    throw createError({ statusCode: 403, statusMessage: "缺少登录会话校验" });
  return token;
}

export async function remoteOperation<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (cause: any) {
    if (cause.statusCode) throw cause;
    throw createError({
      statusCode: 502,
      statusMessage: "美团页面连接失败，请重新连接",
    });
  }
}
