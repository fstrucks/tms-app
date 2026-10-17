// COI request email helpers. Pure (no network). Sending reuses validateSend/postmarkSend from packetSend.js.
import { validateSend } from './packetSend.js';
export { defaultCoiDraft } from './coiTemplate.js';

export const COI_MIGRATION = '20261017001800_insurance_coi.sql';
// Feature flag for the Request COI button (client-visible). Off unless exactly "1" or "true".
export const coiEnabled = (env = process.env) => ['1', 'true'].includes(String(env.NEXT_PUBLIC_COI_REQUEST_ENABLED || '').trim().toLowerCase());

const clip = (s, n) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

// Validates a COI request. → { to, cc, subject, body, certHolder, loadDate } | { error, status, blocked? }
export function validateCoiRequest(b, env = process.env) {
  const v = validateSend(b, env);
  if (v.error) return v;
  const name = clip(b?.certHolder?.name, 200), address = String(b?.certHolder?.address ?? '').trim().slice(0, 500);
  if (!name) return { error: 'Add the certificate holder (broker name).', status: 422 };
  let loadDate = null;
  if (b?.loadDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.loadDate))) return { error: 'Load date must be YYYY-MM-DD.', status: 422 };
    loadDate = String(b.loadDate);
  }
  return { ...v, certHolder: { name, address }, loadDate };
}

export function validateAgent(a) {
  const errors = {};
  const out = { name: clip(a?.name, 120) || null, agency: clip(a?.agency, 160) || null, email: clip(a?.email, 254).toLowerCase() || null, phone: clip(a?.phone, 40) || null };
  if (out.email && !/^[^\s@<>(),;:"\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(out.email)) errors.email = 'Enter a valid email.';
  if (out.phone && !/^[0-9+().\-\s x]{7,40}$/i.test(out.phone)) errors.phone = 'Enter a valid phone number.';
  return { agent: out, errors };
}

const COVS = ['auto_liability', 'cargo', 'general_liability', 'physical_damage', 'other'];
export function validatePolicy(p) {
  const errors = {};
  const date = (v, k) => { if (v == null || v === '') return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) { errors[k] = 'Use YYYY-MM-DD.'; return null; } return String(v); };
  const amt = p?.limit_amount == null || p.limit_amount === '' ? null : Number(String(p.limit_amount).replace(/[$,\s]/g, ''));
  if (amt !== null && (!Number.isFinite(amt) || amt < 0)) errors.limit_amount = 'Enter a dollar amount.';
  if (!COVS.includes(p?.coverage)) errors.coverage = 'Pick a coverage type.';
  const row = { coverage: p?.coverage, insurer: clip(p?.insurer, 160) || null, policy_number: clip(p?.policy_number, 80) || null,
    limit_amount: Number.isFinite(amt) ? amt : null, effective_date: date(p?.effective_date, 'effective_date'), expiry_date: date(p?.expiry_date, 'expiry_date'),
    document_id: /^[0-9a-f-]{36}$/i.test(p?.document_id || '') ? p.document_id : null };
  if (row.effective_date && row.expiry_date && row.expiry_date < row.effective_date) errors.expiry_date = 'Expiry is before the effective date.';
  return { row, errors };
}

// AI output (see ai-extract DOC_TYPES.coi) → unconfirmed policy rows for Marc to review.
export function suggestionsToPolicies(data, documentId = null) {
  return (data?.policies || []).map((p) => validatePolicy({ ...p, document_id: documentId }))
    .filter((r) => !r.errors.coverage)
    .map(({ row }) => ({ ...row, source: 'ai', confirmed: false }));
}
