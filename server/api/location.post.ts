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
  if (
    !body ||
    typeof body.label !== "string" ||
    !body.label.trim() ||
    body.label.length > 100 ||
    (body.cityName !== undefined &&
      (typeof body.cityName !== "string" || body.cityName.length > 50)) ||
    !Number.isFinite(body.latitude) ||
    body.latitude < -90 ||
    body.latitude > 90 ||
    !Number.isFinite(body.longitude) ||
    body.longitude < -180 ||
    body.longitude > 180 ||
    !Number.isInteger(body.cityCode) ||
    body.cityCode < 100000 ||
    body.cityCode > 999999 ||
    (body.automatic !== undefined && typeof body.automatic !== "boolean")
  )
    throw createError({
      statusCode: 400,
      statusMessage: "请填写地址名称、六位城市代码和有效经纬度",
    });
  return withSessionLock(id, async () => {
    const session = await loadSession(id);
    const firstAutomaticLocation = body.automatic === true && !session.location;
    session.location = {
      label: body.label.trim(),
      latitude: body.latitude,
      longitude: body.longitude,
      cityCode: body.cityCode,
      cityName: body.cityName?.trim() || undefined,
    };
    if (!firstAutomaticLocation) {
      session.offers = { xiaochan: [], waimai: [], meituan: [] };
      session.updatedAt = {};
    }
    await saveSession(id, session);
    return publicSession(session);
  });
});
