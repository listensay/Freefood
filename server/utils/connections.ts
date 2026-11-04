import type { H3Event } from "h3";
import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "./session";
import { closeMeituan } from "./meituan";
import type { Provider } from "../../shared/types";

export async function disconnectPlatform(event: H3Event, provider: Provider) {
  const id = sessionId(event);
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    if (provider === "xiaochan") delete session.xiaochanHeaders;
    else {
      await closeMeituan(id);
      delete session.meituanStorage;
    }
    session.connections[provider] = {
      state: "disconnected",
      label: provider === "xiaochan" ? "未连接" : "未登录",
    };
    session.offers[provider] = [];
    delete session.updatedAt[provider];
    await saveSession(id, session);
    return publicSession(session);
  });
}
