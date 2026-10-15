// Shared field list + server-side payload builder for company_profiles.
import { encryptField } from './packetCrypto';
import { normalizeEin, last4, PROFILE_FIELDS } from './companyFields';
export { PROFILE_FIELDS, validateProfile } from './companyFields';
const KEYS = new Set(PROFILE_FIELDS.map(([k]) => k));

// Builds the DB row. EIN is encrypted here (server only); omitted ein = keep existing value.
export function buildRow(input, key) {
  const row = {};
  for (const k of Object.keys(input || {})) if (KEYS.has(k)) {
    const v = String(input[k] ?? '').trim();
    row[k] = v === '' ? null : k === 'state' ? v.toUpperCase() : v;
  }
  if (input && 'ein' in input && input.ein !== undefined) {
    const d = normalizeEin(input.ein);
    row.ein_ciphertext = d ? encryptField(d, key) : null;
    row.ein_last4 = last4(d);
    row.enc_key_version = 1;
  }
  return row;
}

// What the client may see: never the ciphertext.
export function publicProfile(p) {
  if (!p) return null;
  const { ein_ciphertext, enc_key_version, ...rest } = p;
  return { ...rest, has_ein: !!ein_ciphertext };
}
