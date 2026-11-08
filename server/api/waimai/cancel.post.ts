import { defineEventHandler, readBody } from "h3";
import { cancelWaimaiEnrollment } from "../../utils/waimai-enrollment";
import { armWaimaiSchedules } from "../../utils/waimai-schedules";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    await cancelWaimaiEnrollment(session, body?.offerId, { persist: () => saveSession(id, session) });
    armWaimaiSchedules(id, session);
    return publicSession(session);
  });
});
