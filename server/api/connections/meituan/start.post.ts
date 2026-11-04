import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
} from "../../../utils/session";
import { startMeituanLogin } from "../../../utils/meituan";

export default defineEventHandler(async (event) => {
  const id = sessionId(event);
  await startMeituanLogin(id);
  await withSessionLock(id, async () => {
    const session = await loadSession(id);
    if (session.connections.meituan.state !== "connected")
      session.connections.meituan = {
        state: "pending",
        label: "等待官方登录",
        message: "等待官方登录",
      };
    await saveSession(id, session);
  });
  return { message: "登录窗口已打开" };
});
