// Company Documents vault (PR #84; Marc's picks 1A, 2C, 3A, 4A, 5B, 6A, Oct 18 3:10 PM PT). Pure helpers, used by
// the Company page card, /api/company/documents and the Send to broker route. No I/O here.
import { minimumsFrom, COVERAGE_LABELS, REQUIRED_COVERAGES } from './coiGaps.js';

// Always four rows, in this order.
export const VAULT_TYPES = [
  { id: 'w9', label: 'W-9', file: 'W-9' },
  { id: 'coi', label: 'Certificate of Insurance (COI)', short: 'COI', file: 'COI' },
  { id: 'mc_authority', label: 'MC Authority', file: 'MC-Authority' },
  { id: 'noa', label: 'Notice of Assignment (NOA)', short: 'NOA', file: 'NOA' },
];
export const VAULT_TYPE_IDS = VAULT_TYPES.map((t) => t.id);
export const isVaultType = (t) => VAULT_TYPE_IDS.includes(t);
// Fired by the Insurance card after any change; the vault card re-reads so the COI row updates without a reload.
export const INSURANCE_CHANGED_EVENT = 'ph:insurance-changed';
// Fired by the vault card after an upload or delete; the Insurance card re-reads its COI list.
export const VAULT_CHANGED_EVENT = 'ph:vault-changed';
export const vaultLabel = (t) => VAULT_TYPES.find((x) => x.id === t)?.label || t;

// Pick 2C. Upload / replace / delete: owner + management (same as Insurance).
// Read access (Marc, Oct 18, via Sam):
//   - Owner + management: open every vault file, every version.
//   - Drivers (8:45 PM CT decision) and dispatchers (they rank above drivers, so never less access): open the CURRENT
//     COI only. No earlier COI versions. W-9, MC Authority and NOA stay on-file status only.
// All of it is enforced ON THE SERVER (vaultForRole shapes the GET; signedViewUrl checks every file request).
export const VAULT_WRITE_ROLES = new Set(['owner', 'management']);
export const VAULT_MEMBER_ROLES = new Set(['dispatcher', 'driver']);
export const VAULT_MEMBER_OPEN_TYPES = new Set(['coi']); // current version only
export const VAULT_RESTRICTED_TYPES = new Set(['w9', 'mc_authority', 'noa']);
export const canManageVault = (role) => VAULT_WRITE_ROLES.has(role);
export const canSeeEarlierVersions = (role) => VAULT_WRITE_ROLES.has(role);
export const canOpenVaultFile = (role, docType) => isVaultType(docType)
  && (VAULT_WRITE_ROLES.has(role) || (VAULT_MEMBER_ROLES.has(role) && VAULT_MEMBER_OPEN_TYPES.has(docType)));

// Postmark's 10 MB limit counts the base64-encoded message (about 33% larger than the files). Files are capped at
// 7.5 MB raw (one file at upload, and the packet + vault files together on a send), which encodes to 10 MB.
export const MAX_VAULT_FILE_BYTES = 7_500_000;
export const MAX_SEND_RAW_BYTES = 7_500_000;
export const POSTMARK_MAX_ENCODED_BYTES = 10_000_000;
export const encodedSize = (n) => 4 * Math.ceil(Math.max(0, Number(n) || 0) / 3);
// "2.4 MB"; under 0.1 MB it's shown in KB ("48 KB") so small files don't read as "0.0 MB" (#89 QA).
export const fmtSize = (n) => { const b = Math.max(0, Number(n) || 0); return b < 100_000 ? `${Math.max(b > 0 ? 1 : 0, Math.round(b / 1000))} KB` : `${(b / 1_000_000).toFixed(1)} MB`; };
export const fmtMB = fmtSize;

export const VAULT_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
// → null when OK, else a message.
export function checkVaultUpload({ size, contentType } = {}) {
  if (!VAULT_UPLOAD_TYPES.includes(String(contentType || '').toLowerCase())) return 'Use a PDF, JPEG or PNG file.';
  if (!(Number(size) > 0)) return 'That file is empty.';
  if (Number(size) > MAX_VAULT_FILE_BYTES) return `That file is ${fmtMB(size)}. The limit is 7.5 MB, so it still fits in a broker email.`;
  return null;
}

// Total check for a send: the packet PDF + the ticked vault files. → { ok, raw, encoded, error? }
export function checkSendSize(sizes = []) {
  const raw = sizes.reduce((a, n) => a + (Number(n) || 0), 0);
  const encoded = sizes.reduce((a, n) => a + encodedSize(n), 0);
  if (raw > MAX_SEND_RAW_BYTES || encoded > POSTMARK_MAX_ENCODED_BYTES) {
    return { ok: false, raw, encoded, error: `The attachments add up to ${fmtMB(raw)} (${fmtMB(encoded)} once encoded for email). The limit is 7.5 MB (10 MB encoded). Untick a file. Nothing was sent.` };
  }
  return { ok: true, raw, encoded };
}

const ts = (d) => Date.parse(d?.created_at || '') || 0;
// Pick 1A: the newest upload of each type is current; older ones are "earlier versions". → [{ type, label, current, earlier }]
export function groupVault(docs = []) {
  return VAULT_TYPES.map((t) => {
    const mine = docs.filter((d) => d && d.doc_type === t.id).sort((a, b) => ts(b) - ts(a));
    return { type: t.id, label: t.label, current: mine[0] || null, earlier: mine.slice(1) };
  });
}

const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// COI rule (#89 QA): each required coverage (auto liability, cargo) is judged by its BEST VALID CONFIRMED policy:
// in effect (effective date empty or ≤ today) and not expired (expiry empty or ≥ today), highest limit wins, then the
// later expiry. An older, smaller or expired policy next to a good one doesn't count against the COI.
// Unconfirmed AI suggestions never count. → { notes: [{ code, severity, coverage, text }], expiry, best: { cov: policy } }
const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const lim = (p) => (p?.limit_amount === null || p?.limit_amount === undefined || p?.limit_amount === '' || !Number.isFinite(Number(p.limit_amount)) ? null : Number(p.limit_amount));
export function coiCoverage(policies = [], profile = null, today) {
  const t = day(today) || new Date().toISOString().slice(0, 10);
  const mins = minimumsFrom(profile);
  const notes = [], best = {}, expiries = [];
  for (const cov of REQUIRED_COVERAGES) {
    const label = COVERAGE_LABELS[cov];
    const rows = policies.filter((p) => p && p.confirmed && p.coverage === cov);
    if (!rows.length) { notes.push({ code: 'missing', severity: 'error', coverage: cov, text: `${label} coverage is missing.` }); continue; }
    const valid = rows.filter((p) => (!day(p.effective_date) || day(p.effective_date) <= t) && (!day(p.expiry_date) || day(p.expiry_date) >= t));
    if (!valid.length) {
      // a row that starts later (and hasn't already expired) → "not effective yet"; otherwise it's expired
      const future = rows.filter((p) => day(p.effective_date) > t && !(day(p.expiry_date) && day(p.expiry_date) < t)).map((p) => day(p.effective_date)).sort()[0];
      const last = rows.map((p) => day(p.expiry_date)).filter((d) => d && d < t).sort().at(-1);
      notes.push(future
        ? { code: 'not_effective', severity: 'error', coverage: cov, text: `${label} policy isn’t effective until ${future}.` }
        : { code: 'expired', severity: 'error', coverage: cov, text: `${label} policy expired ${last}.` });
      continue;
    }
    const b = [...valid].sort((x, y) => (lim(y) ?? -1) - (lim(x) ?? -1) || String(day(y.expiry_date) || '9999').localeCompare(String(day(x.expiry_date) || '9999')))[0];
    best[cov] = b;
    if (lim(b) === null) notes.push({ code: 'limit_unknown', severity: 'warn', coverage: cov, text: `${label} limit isn’t entered.` });
    else if (lim(b) < mins[cov]) notes.push({ code: 'below_min', severity: 'error', coverage: cov, text: `${label} limit ${usd(lim(b))} is below the ${usd(mins[cov])} minimum.` });
    if (day(b.expiry_date)) expiries.push(day(b.expiry_date));
    else notes.push({ code: 'expiry_unknown', severity: 'warn', coverage: cov, text: `${label} policy has no expiry date.` });
  }
  return { notes, expiry: expiries.sort()[0] || null, best };
}

// Pick 3A: only the COI has an expiry: the earliest expiry of the best valid auto liability and cargo policies.
export function coiExpiry(policies = [], today) { return coiCoverage(policies, null, today).expiry; }

// → { level: 'ok' | 'warn' | 'bad', text, expiry, expiryText, note, hint }
export function vaultStatus(group, { policies = [], profile = null, today } = {}) {
  const t = day(today) || new Date().toISOString().slice(0, 10);
  if (!group?.current) return { level: 'bad', text: 'Missing', expiry: null, expiryText: null, note: null, hint: null };
  if (group.type !== 'coi') {
    let hint = null;
    if (group.type === 'w9' && day(group.current.created_at) && day(group.current.created_at) < addDays(t, -365)) hint = 'This W-9 is over a year old. Some brokers want a current-year W-9.';
    return { level: 'ok', text: 'On file', expiry: null, expiryText: 'No expiry', note: null, hint };
  }
  // Status order (#89 QA): only CONFIRMED policies count. Unconfirmed AI suggestions (even expired ones) never change
  // the pill; they show as a grey hint to review in Insurance.
  //   1. red: a confirmed-policy problem (missing coverage, below minimum, expired, not yet effective)
  //   2. amber "Expires within 30 days" (shown even when there are also amber notes)
  //   3. amber "Check notes": limit or expiry not entered on a confirmed policy
  //   4. green "On file"
  const { notes, expiry: exp } = coiCoverage(policies, profile, t);
  const err = notes.find((n) => n.severity === 'error');
  const warn = notes.find((n) => n.severity === 'warn');
  const pending = policies.filter((p) => p && !p.confirmed).length;
  const hint = pending ? `${pending} suggested polic${pending === 1 ? 'y' : 'ies'} in Insurance still need${pending === 1 ? 's' : ''} your review. ${pending === 1 ? 'It doesn’t' : 'They don’t'} count until confirmed.` : null;
  const expiryText = exp ? `Expires ${exp}` : 'Expiry not entered';
  if (err) return { level: 'bad', text: err.code === 'expired' ? 'Expired' : 'Check notes', expiry: exp, expiryText, note: err.text, hint };
  if (exp && exp <= addDays(t, 30)) return { level: 'warn', text: 'Expires within 30 days', expiry: exp, expiryText, note: warn?.text || null, hint };
  if (warn) return { level: 'warn', text: 'Check notes', expiry: exp, expiryText, note: warn.text, hint };
  return { level: 'ok', text: 'On file', expiry: exp, expiryText, note: null, hint };
}

const fileInfo = (d) => (d ? { id: d.id, original_filename: d.original_filename || null, created_at: d.created_at, load_id: d.load_id ?? null } : null);

// On-file rows whose existing vault status is not "On file" (Check notes, expired, expiring soon). Missing rows stay out.
export function companyAttentionCount(rows) {
  return (rows || []).filter((r) => r?.onFile && r.status?.level && r.status.level !== 'ok').length;
}
export function companyAttentionLabel(n) {
  return n === 1 ? '1 needs attention' : `${n} need attention`;
}

// Shapes the vault for one caller. THIS is the pick 2C read rule: restricted rows go out as status only.
export function vaultForRole(groups, role, ctx = {}) {
  return groups.map((g) => {
    const status = vaultStatus(g, ctx);
    const base = { type: g.type, label: g.label, onFile: !!g.current, status: { level: status.level, text: status.text } };
    if (!canOpenVaultFile(role, g.type)) return { ...base, restricted: true };
    if (!canSeeEarlierVersions(role)) return { ...base, restricted: false, status: { ...status, hint: null }, current: fileInfo(g.current), earlier: [] }; // current only
    return { ...base, restricted: false, status, current: fileInfo(g.current), earlier: g.earlier.map(fileInfo) };
  });
}

// Confirm text for Delete on the current version (Taylor's note: the previous version becomes current again).
export function deleteCurrentPrompt(group, fmtDate = (d) => new Date(d).toLocaleDateString()) {
  const short = VAULT_TYPES.find((t) => t.id === group?.type)?.short || group?.label || 'document';
  const prev = group?.earlier?.[0];
  return prev
    ? `Delete the current ${short}? The previous version (uploaded ${fmtDate(prev.created_at)}) becomes current again.`
    : `Delete the current ${short}? It will show as missing until you upload a new one.`;
}

// Storage path for a new vault file, always under the OWNER's folder.
export function vaultPath(ownerId, docType, filename, now = Date.now()) {
  const safe = String(filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'file';
  return `${ownerId}/company/vault-${docType}-${now}-${safe}`;
}
export const isVaultPathFor = (ownerId, docType, path) => typeof path === 'string' && path.startsWith(`${ownerId}/company/vault-${docType}-`) && !path.includes('..');

// Pick 4A + 6A: the vault part of the Send to broker draft. A flagged or expired COI starts unticked (warn, not block).
export function sendAttachmentOptions(groups, ctx = {}) {
  return groups.map((g) => {
    const st = vaultStatus(g, ctx);
    const t = VAULT_TYPES.find((x) => x.id === g.type);
    if (!g.current) return { type: g.type, label: t.label, available: false, checked: false };
    const flagged = g.type === 'coi' && st.level === 'bad';
    return { type: g.type, label: t.label, available: true, id: g.current.id, filename: attachmentFilename(g.type), checked: !flagged,
      warning: flagged ? `COI: ${sentence(st.note || st.text)} It's unticked; you can still send it.` : (g.type === 'coi' && st.level === 'warn' ? `COI: ${sentence(st.note || st.text)}` : null) };
  });
}
export const attachmentFilename = (type) => `${VAULT_TYPES.find((t) => t.id === type)?.file || 'Document'}.pdf`;

// One sentence with exactly one closing period (#89 QA: "…minimum.. It's unticked").
export const sentence = (t) => `${String(t || '').trim().replace(/[.\s]+$/, '')}.`;
