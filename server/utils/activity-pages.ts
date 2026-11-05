import { createError } from "h3";
import type { Offer } from "../../shared/types";
import { offerWithinRadius } from "../../shared/utils/scope";

export interface ActivityPage {
  offers: Offer[];
  rowKeys: string[];
  hasMore?: boolean;
}

export async function collectActivityPages(
  fetchPage: (page: number) => Promise<ActivityPage>,
  radiusMeters: number,
  options: { maxPages?: number; delayMs?: number } = {},
): Promise<Offer[]> {
  const maxPages = options.maxPages ?? 100;
  const seen = new Set<string>();
  const offers = new Map<string, Offer>();
  for (let page = 0; page < maxPages; page++) {
    if (page > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, options.delayMs ?? 600),
      );
    const result = await fetchPage(page);
    let added = 0;
    for (const key of result.rowKeys) {
      if (!seen.has(key)) added++;
      seen.add(key);
    }
    for (const offer of result.offers) {
      if (offerWithinRadius(offer, radiusMeters)) offers.set(offer.id, offer);
    }
    if (result.hasMore === false || !result.rowKeys.length)
      return [...offers.values()];
    if (page > 0 && added === 0)
      throw createError({
        statusCode: 502,
        statusMessage: "活动分页未更新，请重新同步",
      });
  }
  throw createError({
    statusCode: 502,
    statusMessage: "活动列表未加载完整，请重新同步",
  });
}
