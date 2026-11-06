import { cancelXiaochanEnrollment } from "../../utils/xiaochan-enrollment";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    await cancelXiaochanEnrollment(session, body?.offerId, { persist: () => saveSession(id, session) });
    return publicSession(session);
  });
});
