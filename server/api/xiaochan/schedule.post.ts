import { defineEventHandler, readBody } from "h3";
import { armXiaochanSchedules, createXiaochanSchedule } from "../../utils/xiaochan-schedules";
import { loadSession, publicSession, saveSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    await createXiaochanSchedule(session, body?.offerId, body?.runAt, {
      persist: () => saveSession(id, session),
    });
    armXiaochanSchedules(id, session);
    return publicSession(session);
  });
});
