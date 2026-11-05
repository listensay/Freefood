import type { LocationSettings } from "../types";

export function toGcj02(latitude: number, longitude: number) {
  if (
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    throw new Error("定位坐标无效，请重新定位");
  if (
    longitude < 72.004 ||
    longitude > 137.8347 ||
    latitude < 0.8293 ||
    latitude > 55.8271
  )
    return { latitude, longitude };

  // Browser coordinates are WGS-84; the food platforms use GCJ-02.
  const x = longitude - 105,
    y = latitude - 35;
  const waves = (value: number) =>
    ((20 * Math.sin(6 * value * Math.PI) + 20 * Math.sin(2 * value * Math.PI)) *
      2) /
    3;
  let dLat =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  dLat +=
    waves(x) +
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  dLat +=
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) *
      2) /
    3;
  let dLon =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLon +=
    waves(x) +
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  dLon +=
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) *
      2) /
    3;
  const rad = (latitude * Math.PI) / 180;
  const magic = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2;
  dLat =
    (dLat * 180) /
    (((6378245 * (1 - 0.00669342162296594323)) / (magic * Math.sqrt(magic))) *
      Math.PI);
  dLon =
    (dLon * 180) / ((6378245 / Math.sqrt(magic)) * Math.cos(rad) * Math.PI);
  return { latitude: latitude + dLat, longitude: longitude + dLon };
}

export function addressFromGeocode(
  input: unknown,
  latitude: number,
  longitude: number,
): LocationSettings {
  if (!input || typeof input !== "object")
    throw new Error("地址识别失败，请重新定位或手动填写");
  const data = input as Record<string, any>;
  const regions = Array.isArray(data.localityInfo?.administrative)
    ? data.localityInfo.administrative
        .filter(
          (region: any) =>
            region &&
            typeof region.name === "string" &&
            region.name.trim() &&
            /^[1-9]\d{5}$/.test(String(region.chinaAdminCode)),
        )
        .sort((a: any, b: any) => Number(a.order || 0) - Number(b.order || 0))
    : [];
  const district =
    regions.findLast(
      (region: any) => !String(region.chinaAdminCode).endsWith("00"),
    ) || regions.at(-1);
  if (data.countryCode !== "CN" || !district)
    throw new Error("未识别城市，请手动填写地址");
  const code = String(district.chinaAdminCode);
  const city = regions.find(
    (region: any) => String(region.chinaAdminCode) === `${code.slice(0, 4)}00`,
  );
  const cityName = (
    city?.name ||
    data.city ||
    data.principalSubdivision ||
    ""
  ).trim();
  if (!cityName || cityName.length > 50)
    throw new Error("未识别城市，请手动填写地址");
  const locality =
    typeof data.locality === "string" ? data.locality.trim() : "";
  const label = [
    ...new Set([cityName, district.name.trim(), locality].filter(Boolean)),
  ]
    .join("")
    .slice(0, 100);
  return {
    label,
    cityName,
    cityCode: Number(code),
    ...toGcj02(latitude, longitude),
  };
}
