import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "../../utils/session";
import { parseXiaochanSession } from "../../utils/xiaochan";

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
    session.xiaochanHeaders = headers;
    session.connections.xiaochan = {
      state: "configured",
      label: "会话待验证",
      updatedAt: new Date().toISOString(),
      message:
        "会话待验证",
    };
    session.offers.xiaochan = [];
    delete session.updatedAt.xiaochan;
    await saveSession(id, session);
    return publicSession(session);
  });
});
