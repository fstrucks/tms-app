// Client-safe label helpers shared by naming and "names from last time" (carrier packet G, QA r3).
//   canonicalLabel: "Truck #:" / "TRUCK NUMBER" / "Truck No." → "truck"; "E-mail" → "email"; "Tel." → "phone".
//   labelSimilarity: 0..1 (word overlap, with a character fallback for typos).
//   ruleKeyFor: what a label means when it's unambiguous ("Owner name" → owner_name, "Truck unit #" → truck_number).

const FILLER = new Set(['number', 'no', 'num', 'nbr', 'the', 'your', 'of', 'please', 'enter', 'print', 'full']);
const SYN = { tel: 'phone', telephone: 'phone', ph: 'phone', mail: 'email', usdot: 'dot', unit: '' };
export function canonicalLabel(s) {
  let t = String(s ?? '').toLowerCase().normalize('NFKC').replace(/e[\s-]+mail/g, 'email').replace(/[#№]/g, ' number ')
    .replace(/\p{N}+/gu, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
  const words = t.split(' ').filter(Boolean).map((w) => (w in SYN ? SYN[w] : w)).filter((w) => w && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return words.join(' ') || null;
}
const bigrams = (s) => { const out = []; const t = s.replace(/ /g, ''); for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2)); return out; };
export function labelSimilarity(a, b) {
  const x = canonicalLabel(a), y = canonicalLabel(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  let n = 0; for (const w of A) if (B.has(w)) n++;
  const jac = n / (A.size + B.size - n);
  const ba = bigrams(x), bb = bigrams(y);
  let m = 0; const pool = [...bb]; for (const g of ba) { const i = pool.indexOf(g); if (i >= 0) { m++; pool.splice(i, 1); } }
  const dice = ba.length + bb.length ? (2 * m) / (ba.length + bb.length) : 0;
  return Math.max(jac, dice >= 0.85 ? dice : 0);
}
export const FUZZY_LABEL = 0.6;

// Unambiguous label meanings. `override`: replaces what the AI picked (the AI only knows company-profile keys, so it
// guesses "Signer name" for "Owner name"); otherwise only fills a field the AI left unnamed.
export const LABEL_RULES = [
  { re: /\bowner'?s?\s+(?:full\s+|legal\s+)?name\b/i, key: 'owner_name', override: true },
  { re: /\bdriver'?s?\s+(?:full\s+)?name\b/i, key: 'driver_name', override: true },
  { re: /\btruck\s+(?:license\s+)?plate\s+state\b/i, key: 'truck_plate_state', override: true },
  { re: /\btrailer\s+(?:license\s+)?plate\s+state\b/i, key: 'trailer_plate_state', override: true },
  { re: /\btruck\s+(?:license\s+)?plate\b/i, key: 'truck_plate', override: true },
  { re: /\btrailer\s+(?:license\s+)?plate\b/i, key: 'trailer_plate', override: true },
  { re: /\b(?:truck|tractor)\s*(?:unit\s*)?(?:#|number|no\.?|num)?\s*:?\s*$/i, key: 'truck_number', override: true },
  { re: /\btrailer\s*(?:unit\s*)?(?:#|number|no\.?|num)?\s*:?\s*$/i, key: 'trailer_number', override: true },
  { re: /\bcontact\s+(?:person\s+)?name\b/i, key: 'contact_name', override: false },
  { re: /\bcontact\s+(?:phone|tel|cell)\b/i, key: 'contact_phone', override: false },
  { re: /\bcontact\s+e-?mail\b/i, key: 'contact_email', override: false },
];
export function ruleFor(label) {
  const t = String(label ?? '').trim();
  if (!t) return null;
  return LABEL_RULES.find((r) => r.re.test(t)) || null;
}
export const ruleKeyFor = (label) => ruleFor(label)?.key || null;
// After AI naming: apply the rules. fields: [{ label, profile_key, confidence }] → same shape.
export function applyLabelRules(fields = []) {
  return fields.map((f) => {
    if (f?.kind && f.kind !== 'text') return f;
    const r = ruleFor(f?.label);
    if (!r || (f.profile_key && !r.override) || f.profile_key === r.key) return f;
    return { ...f, profile_key: r.key, confidence: Math.max(Number(f.confidence) || 0, 0.9), needs_confirm: false };
  });
}
