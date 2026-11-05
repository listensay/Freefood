import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "../../utils/session";
import { parseWaimaiToken } from "../../utils/waimai";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const body = await readBody(event);
  if (!body || typeof body.token !== "string")
    throw createError({ statusCode: 400, statusMessage: "请提供歪麦连接信息" });
  let token: string;
  try {
    token = parseWaimaiToken(body.token);
  } catch (error: any) {
    throw createError({ statusCode: 400, statusMessage: error.message });
  }
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    session.waimaiToken = token;
    session.connections.waimai = {
      state: "configured",
      label: token ? "会话待验证" : "访客访问",
      updatedAt: new Date().toISOString(),
    };
    session.offers.waimai = [];
    delete session.updatedAt.waimai;
    await saveSession(id, session);
    return publicSession(session);
  });
});
