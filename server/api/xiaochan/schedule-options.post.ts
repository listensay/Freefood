import { defineEventHandler, readBody } from "h3";
import { getXiaochanScheduleOptions } from "../../utils/xiaochan-advance";
import { loadSession, sessionId, withSessionLock } from "../../utils/session";

export default defineEventHandler(async event => {
  const id = sessionId(event);
  const body = await readBody(event);
  return withSessionLock(id, async () => getXiaochanScheduleOptions(await loadSession(id), body?.offerId));
});
