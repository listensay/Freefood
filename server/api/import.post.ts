import { defineEventHandler, readBody, createError } from "h3";
import { parseOffers } from "../../shared/utils/import";
import { providers, type Provider } from "../../shared/types";
import {
  loadSession,
  saveSession,
  sessionId,
  withSessionLock,
  publicSession,
} from "../utils/session";

export default defineEventHandler(async (event) => {
  const id = sessionId(event),
    body = await readBody(event);
  if (!body || !providers.includes(body.provider))
    throw createError({ statusCode: 400, statusMessage: "请选择导入平台" });
  const provider: Provider = body.provider;
  let offers;
  try {
    offers = parseOffers(body.offers, provider);
  } catch (error: any) {
    throw createError({ statusCode: 400, statusMessage: error.message });
  }
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    session.offers[provider] = offers;
    session.updatedAt[provider] = new Date().toISOString();
    await saveSession(id, session);
    return publicSession(session);
  });
});
