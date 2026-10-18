// Client-safe company profile fields + validation (no crypto here).
// EIN: 9 digits, shown as XX-XXXXXXX. Returns digits or null; throws on bad input.
export function normalizeEin(v) {
  if (v == null || String(v).trim() === '') return null;
  const d = String(v).replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(d)) throw new Error('EIN/TIN must be 9 digits (e.g. 12-3456789).');
  return d;
}
export const last4 = (d) => (d ? String(d).slice(-4) : null);
export const maskEin = (l4) => (l4 ? `•••••${l4}` : '');

export const PROFILE_FIELDS = [
  ['legal_name', 'Legal company name'], ['dba_name', 'DBA (if any)'],
  ['owner_name', 'Owner name'], // column added by 20261018000200_company_owner_name.sql (save degrades gracefully without it)
  ['mc_number', 'MC number'], ['dot_number', 'USDOT number'],
  ['address_line1', 'Street address'], ['address_line2', 'Suite / unit'],
  ['city', 'City'], ['state', 'State'], ['postal_code', 'ZIP'],
  ['phone', 'Phone'], ['email', 'Email'],
  ['signer_name', 'Authorized signer name'], ['signer_title', 'Signer title'],
];

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

