import { createError, getHeader, getRequestURL, type H3Event } from "h3";
import { isAllowedHost, isAllowedPeer } from "./network";

export function assertRequestAccess(event: H3Event, allowDevProxy = false) {
  const url = getRequestURL(event, {
    xForwardedHost: false,
    xForwardedProto: false,
  });
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {}
  const computerWeChat = /^\/api\/connections\/(xiaochan|waimai)\/wechat\/?$/.test(pathname);
  const computerChrome = /^\/api\/connections\/meituan\/browser\/?$/.test(pathname);
  const allowLan = !computerWeChat && !computerChrome && process.env.FOOD_ALLOW_LAN === "1";
  const socket = event.node.req.socket;
  // The dev entry checks the TCP peer before Nitro forwards to its private Unix socket.
  const devProxy =
    allowDevProxy &&
    !!process.env.NITRO_DEV_WORKER_ID &&
    !socket.remoteAddress &&
    !socket.localAddress &&
    !socket.remotePort &&
    Object.keys(socket.address?.() || {}).length === 0 &&
    socket.readable &&
    socket.writable;
  if (
    !isAllowedHost(url.hostname, allowLan) ||
    (!devProxy && !isAllowedPeer(socket.remoteAddress, allowLan))
  )
    throw createError({
      statusCode: 403,
      statusMessage: computerWeChat ? "请在运行服务的电脑连接微信" : computerChrome
        ? "请在运行服务的电脑连接 Chrome" : allowLan
        ? "仅允许本机或局域网访问"
        : "此工具仅允许本机使用，请通过 localhost 访问",
    });
  const origin = getHeader(event, "origin");
  if (origin && origin !== url.origin)
    throw createError({ statusCode: 403, statusMessage: "拒绝跨站请求" });
  if (getHeader(event, "sec-fetch-site") === "cross-site")
    throw createError({ statusCode: 403, statusMessage: "拒绝跨站请求" });
  if (event.method !== "GET" && getHeader(event, "x-food-request") !== "1")
    throw createError({ statusCode: 403, statusMessage: "缺少请求校验头" });
  event.node.res.setHeader("Cache-Control", "no-store");
}
