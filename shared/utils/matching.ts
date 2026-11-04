import type { Offer, StoreMatch } from "../types";

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

export function matchStores(xiaochan: Offer[], meituan: Offer[]): StoreMatch[] {
  const matches: StoreMatch[] = [];
  for (const x of xiaochan) {
    for (const m of meituan) {
      let confidence: StoreMatch["confidence"] | undefined;
      let reason = "";
      // A Xiaochan internal store ID and an anonymized Meituan -100/0 are never cross-platform IDs.
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
          xiaochan: x,
          meituan: m,
          confidence,
          reason,
        });
    }
  }
  return matches;
}
