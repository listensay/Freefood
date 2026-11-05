import {
  loadSession,
  saveSession,
  publicSession,
  sessionId,
  withSessionLock,
} from "../../../../utils/session";
import { endMeituanRemote, hasMeituanBrowser } from "../../../../utils/meituan";
import { remoteToken } from "../../../../utils/remote-request";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  await endMeituanRemote(id, remoteToken(event));
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    if (
      session.connections.meituan.state === "pending" &&
      !hasMeituanBrowser(id)
    )
      session.connections.meituan = { state: "disconnected", label: "未登录" };
    await saveSession(id, session);
    return publicSession(session);
  });
});
