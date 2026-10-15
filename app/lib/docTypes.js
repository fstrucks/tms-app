// Pick 7A (Marc): scanner document types. Keys are stored in documents.doc_type (plain text, no check constraint).
// Keep 'bol' / 'pod' keys as-is; existing rows use them.
export const SCAN_DOC_TYPES = [
  { id: 'bol', label: 'Bill of lading', short: 'BOL', button: 'BOL' },
  { id: 'pod', label: 'Proof of delivery', short: 'POD', button: 'POD' },
  { id: 'lumper_receipt', label: 'Lumper receipt', short: 'LUMPER', button: 'Lumper Receipt' },
  { id: 'w9', label: 'W-9', short: 'W9', button: 'W-9' },
  { id: 'coi', label: 'Certificate of insurance', short: 'COI', button: 'COI' },
  { id: 'mc_authority', label: 'MC authority letter', short: 'MC_AUTHORITY', button: 'MC Authority' },
  // Free-text type (Marc): stored as doc_type 'other:<name>' (no migration; doc_type is plain text).
  { id: 'other', label: 'Other', short: 'OTHER', button: null },
];

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
