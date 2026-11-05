import type { Offer, StoreMatch, StoreMatchGroup } from "../types";

export function normalizeStoreName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•\-—_.,，。()（）\[\]【】]/g, "");
}

function branch(name: string): string {
  const match = /[（(【\[]([^）)】\]]+)[）)】\]]/.exec(name);
  return match ? normalizeStoreName(match[1]!) : "";
}

function similarity(a: string, b: string): number {
  if (a.length < 3 || b.length < 3) return 0;
  const grams = (text: string) =>
    new Set(
      Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)),
    );
  const x = grams(a),
    y = grams(b);
  const intersection = [...x].filter((g) => y.has(g)).length;
  return (2 * intersection) / (x.size + y.size);
}

export function matchStores(bawangcan: Offer[], meituan: Offer[]): StoreMatch[] {
  const matches: StoreMatch[] = [];
  for (const x of bawangcan) {
    if (x.provider === "meituan") continue;
    for (const m of meituan) {
      let confidence: StoreMatch["confidence"] | undefined;
      let reason = "";
      // Internal platform IDs and anonymized Meituan -100/0 are not shared store IDs.
      if (x.meituanPoiId && m.meituanPoiId) {
        if (x.meituanPoiId !== m.meituanPoiId) continue;
        confidence = "id";
        reason = "美团门店 ID 一致";
      } else {
        const a = normalizeStoreName(x.name),
          b = normalizeStoreName(m.name);
        const xb = branch(x.name),
          mb = branch(m.name);
        if (xb && mb && xb !== mb) continue;
        if (a === b) {
          confidence = "name";
          reason = "完整店名一致，分店待核验";
        } else if (similarity(a, b) >= 0.84) {
          confidence = "candidate";
          reason = "店名相似，需人工确认";
        }
      }
      if (confidence)
        matches.push({
          id: `${x.id}::${m.id}`,
          bawangcan: x,
          meituan: m,
          confidence,
          reason,
        });
    }
  }
  return matches;
}

export function groupStoreMatches(matches: StoreMatch[]): StoreMatchGroup[] {
  const groups = new Map<string, StoreMatchGroup>();
  const storeIdentity = (offer: Offer) =>
    offer.meituanPoiId
      ? ["poi", offer.meituanPoiId]
      : offer.opaquePoiId
        ? ["opaque", offer.opaquePoiId]
        : ["name", normalizeStoreName(offer.name), offer.address?.trim() || ""];
  for (const match of matches) {
    const id = JSON.stringify([
      match.bawangcan.provider,
      storeIdentity(match.bawangcan),
      storeIdentity(match.meituan),
      match.bawangcan.product?.name.normalize("NFKC").trim().toLowerCase() || "",
    ]);
    const group = groups.get(id);
    if (group) group.matches.push(match);
    else groups.set(id, { id, matches: [match] });
  }
  return [...groups.values()];
}
