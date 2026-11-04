import { loadSession, publicSession, sessionId } from "../utils/session";

export default defineEventHandler(async (event) =>
  publicSession(await loadSession(sessionId(event))),
);
