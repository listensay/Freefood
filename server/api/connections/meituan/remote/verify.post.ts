import { defineEventHandler } from "h3";
import {
  loadSession,
  publicSession,
  sessionId,
} from "../../../../utils/session";
import { verifyMeituanLogin } from "../../../../utils/meituan";
import { remoteOperation, remoteToken } from "../../../../utils/remote-request";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const token = remoteToken(event);
  await remoteOperation(() => verifyMeituanLogin(id, token));
  return publicSession(await loadSession(id));
});
