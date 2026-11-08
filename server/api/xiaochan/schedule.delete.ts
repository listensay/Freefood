import { defineEventHandler, readBody } from "h3";
import { withXiaochanAdvanceLock } from "../../utils/xiaochan-advance-lock";
import { xiaochanAdvanceAccountId } from "../../utils/xiaochan-advance";
import { armXiaochanSchedules, cancelXiaochanSchedule } from "../../utils/xiaochan-schedules";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    return withXiaochanAdvanceLock(xiaochanAdvanceAccountId(session), async () => {
      const previous = session.xiaochanSchedules?.[body?.offerId];
      cancelXiaochanSchedule(session, body?.offerId);
      try { await saveSession(id, session); } catch (error) {
        if (previous) session.xiaochanSchedules![body.offerId] = previous;
        throw error;
      }
      armXiaochanSchedules(id, session);
      return publicSession(session);
    });
  });
});
