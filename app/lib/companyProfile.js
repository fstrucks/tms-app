// Shared field list + server-side payload builder for company_profiles.
import { encryptField, normalizeEin, last4 } from './packetCrypto';

export const PROFILE_FIELDS = [
  ['legal_name', 'Legal company name'], ['dba_name', 'DBA (if any)'],
  ['mc_number', 'MC number'], ['dot_number', 'USDOT number'],
  ['address_line1', 'Street address'], ['address_line2', 'Suite / unit'],
  ['city', 'City'], ['state', 'State'], ['postal_code', 'ZIP'],
  ['phone', 'Phone'], ['email', 'Email'],
  ['signer_name', 'Authorized signer name'], ['signer_title', 'Signer title'],
];
const KEYS = new Set(PROFILE_FIELDS.map(([k]) => k));

export function validateProfile(input = {}) {
  const errs = {};
  if (!String(input.legal_name || '').trim()) errs.legal_name = 'Legal company name is required.';
  if (input.state && !/^[A-Za-z]{2}$/.test(String(input.state).trim())) errs.state = 'Use the 2-letter state code.';
  if (input.postal_code && !/^\d{5}(-\d{4})?$/.test(String(input.postal_code).trim())) errs.postal_code = 'ZIP must be 5 digits.';
  if (input.dot_number && !/^\d{1,8}$/.test(String(input.dot_number).trim())) errs.dot_number = 'USDOT is digits only.';
  if (input.mc_number && !/^(MC-?)?\d{1,8}$/i.test(String(input.mc_number).trim())) errs.mc_number = 'MC is digits only (MC- prefix optional).';
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(input.email).trim())) errs.email = 'Enter a valid email.';
  try { normalizeEin(input.ein); } catch (e) { errs.ein = e.message; }
  return errs;
}

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
