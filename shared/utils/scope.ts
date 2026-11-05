import type { Offer, StoreMatch } from "../types";

export const COMPARISON_RADIUS_METERS = 7000;

export function offerWithinRadius(offer: Offer, radiusMeters: number): boolean {
  const distance = offer.distanceMeters;
  return (
    distance !== undefined &&
    Number.isFinite(distance) &&
    distance >= 0 &&
    distance <= radiusMeters
  );
}

export function matchWithinRadius(
  match: StoreMatch,
  radiusMeters: number,
): boolean {
  const distances = [
    match.bawangcan.distanceMeters,
    match.meituan.distanceMeters,
  ].filter((distance): distance is number => distance !== undefined);
  return (
    distances.length > 0 &&
    distances.every(
      (distance) =>
        Number.isFinite(distance) && distance >= 0 && distance <= radiusMeters,
    )
  );
}
