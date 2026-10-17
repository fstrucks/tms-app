// Rate con / load weight → whole pounds (pure). Accepts numbers and text as printed on rate cons:
// 38500, "38500", "38,500 lbs", "38,500 LB", "38.5k lbs", "17,463 kg" (→ lb). Null when missing,
// unreadable, or outside 1..200,000 lb.
export const MAX_LOAD_WEIGHT_LB = 200000;
const KG_TO_LB = 2.20462;
export function parseWeightLb(v) {
  if (v === null || v === undefined || v === '') return null;
  let n, kg = false;
  if (typeof v === 'number') n = v;
  else {
    const s = String(v).toLowerCase().replace(/\s+/g, ' ').trim();
    const m = /(-?\d[\d,]*(?:\.\d+)?)\s*(k\b|k\s*(?=lb|kg))?/.exec(s);
    if (!m) return null;
    n = Number(m[1].replace(/,/g, ''));
    if (m[2]) n *= 1000;
    kg = /\d\s*k?\s*(kg|kgs|kilo)/.test(s);
  }
  if (!Number.isFinite(n)) return null;
  const lb = Math.round(kg ? n * KG_TO_LB : n);
  return lb >= 1 && lb <= MAX_LOAD_WEIGHT_LB ? lb : null;
}
// Weight to copy into loads.weight from a rate con's ai_extracted_data (new reads have weight_lb; also accepts weight text).
export const extractedWeightLb = (x) => parseWeightLb(x?.weight_lb ?? x?.weight ?? null);
