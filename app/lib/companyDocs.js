// Company Documents vault (PR #84; Marc's picks 1A, 2C, 3A, 4A, 5B, 6A, Oct 18 3:10 PM PT). Pure helpers, used by
// the Company page card, /api/company/documents and the Send to broker route. No I/O here.
import { coiGaps } from './coiGaps.js';
import { companyGapNotes, suggestedExpiredNotes } from './coiRequest.js';

// Always four rows, in this order.
export const VAULT_TYPES = [
  { id: 'w9', label: 'W-9', file: 'W-9' },
  { id: 'coi', label: 'Certificate of Insurance (COI)', short: 'COI', file: 'COI' },
  { id: 'mc_authority', label: 'MC Authority', file: 'MC-Authority' },
  { id: 'noa', label: 'Notice of Assignment (NOA)', short: 'NOA', file: 'NOA' },
];
export const VAULT_TYPE_IDS = VAULT_TYPES.map((t) => t.id);
export const isVaultType = (t) => VAULT_TYPE_IDS.includes(t);
export const vaultLabel = (t) => VAULT_TYPES.find((x) => x.id === t)?.label || t;

// Pick 2C. Upload / replace / delete: owner + management (same as Insurance).
// W-9 and NOA files: owner + management only. Dispatchers and drivers get on-file status only, stripped ON THE SERVER.
export const VAULT_WRITE_ROLES = new Set(['owner', 'management']);
export const VAULT_RESTRICTED_TYPES = new Set(['w9', 'noa']);
export const canManageVault = (role) => VAULT_WRITE_ROLES.has(role);
export const canOpenVaultFile = (role, docType) => isVaultType(docType) && (!VAULT_RESTRICTED_TYPES.has(docType) || VAULT_WRITE_ROLES.has(role));

// Postmark's 10 MB limit counts the base64-encoded message (about 33% larger than the files). Files are capped at
// 7.5 MB raw (one file at upload, and the packet + vault files together on a send), which encodes to 10 MB.
export const MAX_VAULT_FILE_BYTES = 7_500_000;
export const MAX_SEND_RAW_BYTES = 7_500_000;
export const POSTMARK_MAX_ENCODED_BYTES = 10_000_000;
export const encodedSize = (n) => 4 * Math.ceil(Math.max(0, Number(n) || 0) / 3);
export const fmtMB = (n) => `${(Math.max(0, Number(n) || 0) / 1_000_000).toFixed(1)} MB`;

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

// Pick 3A: only the COI has an expiry: the earliest expiry of the CONFIRMED auto liability and cargo policies.
export function coiExpiry(policies = []) {
  const dates = policies.filter((p) => p && p.confirmed && ['auto_liability', 'cargo'].includes(p.coverage)).map((p) => day(p.expiry_date)).filter(Boolean).sort();
  return dates[0] || null;
}

// → { level: 'ok' | 'warn' | 'bad', text, expiry, expiryText, note, hint }
export function vaultStatus(group, { policies = [], profile = null, today } = {}) {
  const t = day(today) || new Date().toISOString().slice(0, 10);
  if (!group?.current) return { level: 'bad', text: 'Missing', expiry: null, expiryText: null, note: null, hint: null };
  if (group.type !== 'coi') {
    let hint = null;
    if (group.type === 'w9' && day(group.current.created_at) && day(group.current.created_at) < addDays(t, -365)) hint = 'This W-9 is over a year old. Some brokers want a current-year W-9.';
    return { level: 'ok', text: 'On file', expiry: null, expiryText: 'No expiry', note: null, hint };
  }
  const exp = coiExpiry(policies);
  const notes = [...companyGapNotes(coiGaps({ policies, profile, today: t })), ...(suggestedExpiredNotes(policies, t) || []).map((x) => (typeof x === 'string' ? { severity: 'warn', text: x } : x))];
  const err = notes.find((n) => n.severity === 'error');
  const warn = notes.find((n) => n.severity === 'warn');
  const expiryText = exp ? `Expires ${exp}` : 'Expiry not entered';
  if (err) return { level: 'bad', text: exp && exp < t ? 'Expired' : 'Check notes', expiry: exp, expiryText, note: err.text, hint: null };
  if (exp && exp <= addDays(t, 30)) return { level: 'warn', text: 'Expires within 30 days', expiry: exp, expiryText, note: warn?.text || null, hint: null };
  if (warn) return { level: 'warn', text: 'Check notes', expiry: exp, expiryText, note: warn.text, hint: null };
  return { level: 'ok', text: 'On file', expiry: exp, expiryText, note: null, hint: null };
}

const fileInfo = (d) => (d ? { id: d.id, original_filename: d.original_filename || null, created_at: d.created_at, load_id: d.load_id ?? null } : null);

// Shapes the vault for one caller. THIS is the pick 2C read rule: restricted rows go out as status only.
export function vaultForRole(groups, role, ctx = {}) {
  return groups.map((g) => {
    const status = vaultStatus(g, ctx);
    const base = { type: g.type, label: g.label, onFile: !!g.current, status: { level: status.level, text: status.text } };
    if (!canOpenVaultFile(role, g.type)) return { ...base, restricted: true };
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
      warning: flagged ? `COI: ${st.note || st.text}. It's unticked; you can still send it.` : (g.type === 'coi' && st.level === 'warn' ? `COI: ${st.note || st.text}.` : null) };
  });
}
export const attachmentFilename = (type) => `${VAULT_TYPES.find((t) => t.id === type)?.file || 'Document'}.pdf`;
