import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
} from "../../../utils/session";
import {
  isMeituanRemoteActive,
  startMeituanLogin,
} from "../../../utils/meituan";
import { remoteOperation } from "../../../utils/remote-request";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  const remote = await remoteOperation(() => startMeituanLogin(id));
  await withSessionLock(id, async () => {
    if (!isMeituanRemoteActive(id, remote.token))
      throw createError({ statusCode: 410, statusMessage: "登录窗口已关闭" });
    const session = await loadSession(id);
    if (session.connections.meituan.state !== "connected")
      session.connections.meituan = {
        state: "pending",
        label: "等待官方登录",
        message: "等待官方登录",
      };
    await saveSession(id, session);
  });
  return remote;
});
