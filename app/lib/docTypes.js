// Pick 7A (Marc): scanner document types. Keys are stored in documents.doc_type (plain text, no check constraint).
// Keep 'bol' / 'pod' keys as-is; existing rows use them.
export const SCAN_DOC_TYPES = [
  { id: 'bol', label: 'Bill of lading', short: 'BOL', button: 'BOL' },
  { id: 'pod', label: 'Proof of delivery', short: 'POD', button: 'POD' },
  { id: 'lumper_receipt', label: 'Lumper receipt', short: 'LUMPER', button: 'Lumper Receipt' },
  { id: 'w9', label: 'W-9', short: 'W9', button: 'W-9', company: true },
  { id: 'coi', label: 'Certificate of Insurance (COI)', short: 'COI', button: 'COI', company: true },
  { id: 'mc_authority', label: 'MC Authority', short: 'MC_AUTHORITY', button: 'MC Authority', company: true },
  // Free-text type (Marc): stored as doc_type 'other:<name>' (no migration; doc_type is plain text).
  { id: 'other', label: 'Other', short: 'OTHER', button: null },
];

// Marc 10/15: company documents (not tied to a load). Picking one defaults Load to "No load".
export const COMPANY_DOC_TYPE_IDS = SCAN_DOC_TYPES.filter((t) => t.company).map((t) => t.id);
export function isCompanyDocType(id) { return COMPANY_DOC_TYPE_IDS.includes(id); }
// Marc 10/15 (via Sam): load-page Scan offers BOL, POD, Lumper receipt, and Other.
export const LOAD_SCAN_TYPE_IDS = ['bol', 'pod', 'lumper_receipt', 'other'];

export const OTHER_PREFIX = 'other:';
export const OTHER_MAX = 40;

// "Other" name -> stored doc_type. Trims, collapses spaces, caps at OTHER_MAX. Null when empty.
export function otherDocType(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, OTHER_MAX).trim();
  return clean ? OTHER_PREFIX + clean : null;
}

// Display label for any stored doc_type, including 'other:<name>'.
export function docTypeLabel(docType) {
  if (!docType) return '';
  if (docType.startsWith(OTHER_PREFIX)) return docType.slice(OTHER_PREFIX.length) || 'Other';
  return DOC_TYPE_LABEL[docType] || docType.replaceAll('_', ' ');
}

// Primary scanner button. Long names fall back so the button stays one line at 390px.
export const UPLOAD_LABEL_MAX = 26;
export function uploadButtonLabel(typeId) {
  const name = typeId === 'ratecon' ? 'Rate Confirmation' : SCAN_DOC_TYPES.find((t) => t.id === typeId)?.button;
  const text = name ? `Upload ${name}` : 'Upload Document';
  return text.length > UPLOAD_LABEL_MAX ? 'Upload Document' : text;
}

export const DOC_TYPE_LABEL = Object.fromEntries([
  ['rate_confirmation', 'Rate confirmation'],
  ...SCAN_DOC_TYPES.map((t) => [t.id, t.label]),
]);

export function docTypeShort(id) {
  return SCAN_DOC_TYPES.find((t) => t.id === id)?.short || (id || 'scan').toUpperCase();
}

// Documents page "Document type" for the Upload button. Rate confirmation keeps AI extraction (and COI auto-detect);
// the rest are saved as-is. 'other' needs a name, so it stays in the scanner only.
export const UPLOAD_TYPES = [
  { id: 'rate_confirmation', label: 'Rate confirmation (reads load details)', short: 'Rate confirmation' },
  ...SCAN_DOC_TYPES.filter((t) => t.id !== 'other').map((t) => ({ id: t.id, label: t.label, short: t.label })),
];
export function uploadTypeFromQuery(search) {
  const t = new URLSearchParams(search || '').get('type');
  return UPLOAD_TYPES.some((x) => x.id === t) ? t : null;
}
// Change type on saved documents (server enforces the same in /api/documents/[id]/type).
export const canChangeDocType = (role) => role === 'owner' || role === 'management';

// PATCH /api/documents/:id/type. Never throws: { ok:true, docType, offerRead } from the SERVER response,
// or { ok:false, error } on a network error (e.g. net::ERR_CONNECTION_CLOSED) or any non-2xx.
export async function saveDocType({ id, docType, token, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`/api/documents/${id}/type`, { method: 'PATCH', cache: 'no-store', headers: { Authorization: `Bearer ${token || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ docType }) });
  } catch { return { ok: false, error: 'Couldn’t reach the server. Type not changed.' }; }
  const j = await res.json().catch(() => ({}));
  const serverType = j?.document?.doc_type || j?.docType;
  if (!res.ok || !serverType) return { ok: false, error: j?.error || `Couldn’t change the type (error ${res.status}). Type not changed.` };
  return { ok: true, docType: serverType, offerRead: !!j.offerRead };
}
