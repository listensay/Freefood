import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "../../utils/session";
import { isXiaochanGuest, parseXiaochanSession } from "../../utils/xiaochan";

export default defineEventHandler(async (event) => {
  const id = sessionId(event),
    body = await readBody(event);
  let headers: Record<string, string>;
  try {
    headers = parseXiaochanSession(body?.session || "");
  } catch (error: any) {
    throw createError({ statusCode: 400, statusMessage: error.message });
  }
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const label = isXiaochanGuest(headers) ? "访客待验证" : "会话待验证";
    session.xiaochanHeaders = headers;
    session.connections.xiaochan = {
      state: "configured",
      label,
      updatedAt: new Date().toISOString(),
      message: label,
    };
    session.offers.xiaochan = [];
    delete session.updatedAt.xiaochan;
    await saveSession(id, session);
    return publicSession(session);
  });
});
