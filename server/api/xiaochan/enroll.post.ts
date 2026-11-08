import { defineEventHandler, readBody } from "h3";
import { enrollXiaochan } from "../../utils/xiaochan-enrollment";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    await enrollXiaochan(session, body?.offerId, {
      persist: () => saveSession(id, session),
    });
    if (session.xiaochanSchedules?.[body.offerId]) {
      delete session.xiaochanSchedules[body.offerId];
      await saveSession(id, session);
    }
    return publicSession(session);
  });
});
