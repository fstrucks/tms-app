// Value-format checks for mapped fields (local, deterministic). The model only names fields;
// these checks run server-side on profile values, so secrets never leave the server.
export function abaValid(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 9) return false;
  const n = [...d].map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}
const RULES = {
  mc_number: [/^(MC-?)?\d{4,8}$/i, 'MC number should be 4-8 digits'],
  dot_number: [/^\d{5,8}$/, 'USDOT number should be 5-8 digits'],
  ein: [/^\d{2}-?\d{7}$/, 'EIN should look like 12-3456789'],
  postal_code: [/^\d{5}(-\d{4})?$/, 'ZIP should be 5 or 9 digits'],
  state: [/^[A-Z]{2}$/i, 'State should be a 2-letter code'],
  phone: [/^\D*(\d\D*){10,11}$/, 'Phone should have 10 digits'],
  email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email looks invalid'],
  bank_account: [/^\d{4,17}$/, 'Account number should be 4-17 digits'],
};
RULES.contact_phone = RULES.phone;
RULES.contact_email = RULES.email;
// Returns { ok, message, needs_confirm }. Bank fields always need the user's confirmation.
export function checkValue(key, value) {
  const v = String(value ?? '').trim();
  const needs_confirm = key === 'bank_routing' || key === 'bank_account';
  if (!v) return { ok: false, message: 'Missing', needs_confirm };
  if (key === 'bank_routing') return abaValid(v) ? { ok: true, needs_confirm } : { ok: false, message: 'Routing number fails the ABA check', needs_confirm };
  const r = RULES[key];
  if (r && !r[0].test(v)) return { ok: false, message: r[1], needs_confirm };
  return { ok: true, needs_confirm };
}
// Low confidence flag threshold for the review UI (PR E).
export const LOW_CONFIDENCE = 0.6;
