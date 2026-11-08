import { defineEventHandler, readBody } from "h3";
import { armWaimaiSchedules, setWaimaiSchedule } from "../../utils/waimai-schedules";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const previous = session.waimaiSchedules?.[body?.offerId];
    setWaimaiSchedule(session, body?.offerId, body?.runAt);
    try {
      await saveSession(id, session);
    } catch (error) {
      if (previous) session.waimaiSchedules![body.offerId] = previous;
      else delete session.waimaiSchedules?.[body.offerId];
      throw error;
    }
    armWaimaiSchedules(id, session);
    return publicSession(session);
  });
});
