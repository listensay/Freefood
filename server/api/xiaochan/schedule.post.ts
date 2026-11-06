import { armXiaochanSchedules, setXiaochanSchedule } from "../../utils/xiaochan-schedules";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const previous = session.xiaochanSchedules?.[body?.offerId];
    setXiaochanSchedule(session, body?.offerId, body?.runAt);
    try {
      await saveSession(id, session);
    } catch (error) {
      if (previous) session.xiaochanSchedules![body.offerId] = previous;
      else delete session.xiaochanSchedules?.[body.offerId];
      throw error;
    }
    armXiaochanSchedules(id, session);
    return publicSession(session);
  });
});
