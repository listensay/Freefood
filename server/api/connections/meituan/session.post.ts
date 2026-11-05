import { parseMeituanSession } from "../../../utils/meituan-session";
import { closeMeituan } from "../../../utils/meituan";
import {
  loadSession,
  saveSession,
  publicSession,
  sessionId,
  withSessionLock,
} from "../../../utils/session";

export default defineEventHandler(async (event) => {
  const id = sessionId(event),
    body = await readBody(event);
  let storage;
  try {
    storage = parseMeituanSession(body?.session);
  } catch (cause: any) {
    throw createError({ statusCode: 400, statusMessage: cause.message });
  }
  return withSessionLock(id, async () => {
    await closeMeituan(id);
    const local = await loadSession(id);
    local.meituanStorage = storage;
    local.connections.meituan = {
      state: "configured",
      label: "会话待验证",
      message: "会话待验证",
      updatedAt: new Date().toISOString(),
    };
    local.offers.meituan = [];
    delete local.updatedAt.meituan;
    await saveSession(id, local);
    return publicSession(local);
  });
});
