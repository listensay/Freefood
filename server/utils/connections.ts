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
import { armWaimaiSchedules } from "./waimai-schedules";

export async function disconnectPlatform(event: H3Event, provider: Provider) {
  const id = sessionId(event);
  return withSessionLock(id, async () => {
    const session = structuredClone(await loadSession(id));
    if (provider === "xiaochan") {
      delete session.xiaochanAccount;
      delete session.xiaochanEnrollments;
      delete session.xiaochanSchedules;
    }
    else if (provider === "waimai") {
      delete session.waimaiAccount;
      delete session.waimaiEnrollments;
      delete session.waimaiSchedules;
    }
    else {
      await closeMeituan(id);
      delete session.meituanStorage;
      delete session.meituanAccountId;
    }
    session.connections[provider] = {
      state: "disconnected",
      label: provider === "meituan" ? "未登录" : "未连接",
    };
    session.offers[provider] = [];
    delete session.updatedAt[provider];
    await saveSession(id, session);
    if (provider === "waimai") armWaimaiSchedules(id, session);
    return publicSession(session);
  });
}
