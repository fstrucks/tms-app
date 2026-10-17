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

// Suggest idempotency: one row per document + coverage + (policy number, else insurer).
export function policyKey(p) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${p?.coverage || ''}|${norm(p?.policy_number) ? 'n:' + norm(p.policy_number) : 'i:' + norm(p?.insurer)}`;
}
const SUGGEST_FIELDS = ['insurer', 'policy_number', 'limit_amount', 'effective_date', 'expiry_date'];
// → { insert: [rows], update: [{ id, patch }], skipped: n }. Confirmed rows (on any document) are never touched;
// existing unconfirmed rows from the SAME document are updated in place; repeats within one reading collapse.
export function planSuggestions(suggested, existing, documentId) {
  const confirmed = new Set(existing.filter((r) => r.confirmed).map(policyKey));
  const mine = new Map(existing.filter((r) => !r.confirmed && r.document_id === documentId).map((r) => [policyKey(r), r]));
  const seen = new Set(); const insert = [], update = []; let skipped = 0;
  for (const s of suggested) {
    const k = policyKey(s);
    if (seen.has(k) || confirmed.has(k)) { skipped++; continue; }
    seen.add(k);
    const cur = mine.get(k);
    if (!cur) { insert.push(s); continue; }
    const patch = Object.fromEntries(SUGGEST_FIELDS.filter((f) => s[f] != null && s[f] !== cur[f]).map((f) => [f, s[f]]));
    if (Object.keys(patch).length) update.push({ id: cur.id, patch }); else skipped++;
  }
  return { insert, update, skipped };
}

// Ids of duplicate UNCONFIRMED rows for one document (same key), keeping the earliest-created row.
// Lets two simultaneous Suggest calls converge to one row each without a DB unique index.
export function duplicateSuggestionIds(rows, documentId) {
  const keep = new Map(), drop = [];
  const sorted = rows.filter((r) => r.document_id === documentId && !r.confirmed)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
  for (const r of sorted) { const k = policyKey(r); if (keep.has(k)) drop.push(r.id); else keep.set(k, r.id); }
  return drop;
}

// /company gap notes: coverage gaps + "needs your confirmation", without packet-only items (holder, load date).
export function companyGapNotes(gaps) { return (gaps || []).filter((g) => !String(g.code).startsWith('cert_holder')); }

// Status line after Suggest.
export function suggestMessage(r) {
  if (!r.found) return r.note || 'No coverage lines found on that document.';
  const parts = [];
  if (r.added) parts.push(`${r.added} suggested polic${r.added === 1 ? 'y' : 'ies'} added`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.skipped) parts.push(`${r.skipped} already on file`);
  return `${parts.join(', ')}.${r.added || r.updated ? ' Check and confirm each one.' : ''}`;
}

// Expired AI-suggested (unconfirmed) policies, flagged on /company before confirmation.
const mmdd = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
export function suggestedExpiredLabel(p, today) {
  const exp = String(p?.expiry_date || '').slice(0, 10);
  if (!p || p.confirmed || !/^\d{4}-\d{2}-\d{2}$/.test(exp) || exp >= today) return null;
  return `Suggested, expired ${mmdd(exp)}`;
}
export function suggestedExpiredNotes(policies, today) {
  return (policies || []).filter((p) => suggestedExpiredLabel(p, today)).map((p) => ({ code: 'suggested_expired', severity: 'error', coverage: p.coverage,
    text: `Suggested ${String(COVERAGE_LABELS_LC[p.coverage] || 'policy')}${p.policy_number ? ` ${p.policy_number}` : ''} expired ${mmdd(String(p.expiry_date).slice(0, 10))}. Get a current COI before confirming it.` }));
}
const COVERAGE_LABELS_LC = { auto_liability: 'auto liability policy', cargo: 'cargo policy', general_liability: 'general liability policy', workers_comp: 'workers comp policy' };
export const MIN_BUSY_MS = 600;
export async function atLeast(promise, ms = MIN_BUSY_MS, wait = (t) => new Promise((r) => setTimeout(r, t))) {
  const [v] = await Promise.all([promise, wait(ms)]); return v;
}
