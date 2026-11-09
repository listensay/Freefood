import { defineEventHandler, readBody, type EventHandler } from "h3";
import { sessionId } from "./session";
import { sessionDatabase } from "./session-database";
import { logOperation } from "./runtime-logs";
import type { LogAction } from "../../shared/runtime-logs";
import { providers } from "../../shared/types";

export function loggedHandler(handler: EventHandler): EventHandler {
  return defineEventHandler(async event => {
    const path = event.path.split("?")[0]!;
    const tail = path.split("/").at(-1)!;
    if (event.method === "GET" || path.includes("/remote/input") || path.includes("/remote/end")) return handler(event);
    const id = sessionId(event);
    await sessionDatabase();
    const provider = providers.find(provider => path.split("/").includes(provider));
    const action: LogAction = tail === "sync" ? "sync" : tail === "location" ? "location" : tail === "import" ? "import"
      : tail === "schedule" ? (event.method === "DELETE" ? "cancel-schedule" : "schedule")
      : tail === "schedule-options" ? "coupons" : tail === "enroll" ? "enroll" : tail === "cancel" ? "cancel"
      : tail === "profile" ? "profile" : tail === "verify" ? "verify" : event.method === "DELETE" ? "disconnect" : "connect";
    const body = event.method === "POST" ? await readBody(event) : undefined;
    const source = action === "profile" || (body?.automatic === true && ["sync", "location"].includes(action)) ? "automatic" : "manual";
    return logOperation({ sessionId: id, action, provider, source }, () => handler(event));
  });
}
