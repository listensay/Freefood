import { defineEventHandler } from "h3";
import { loadSession, publicSession, sessionId } from "../../../utils/session";
import { verifyMeituanLogin } from "../../../utils/meituan";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  await verifyMeituanLogin(id);
  return publicSession(await loadSession(id));
});
