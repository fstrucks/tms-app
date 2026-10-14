// Pick 7A (Marc): scanner document types. Keys are stored in documents.doc_type (plain text, no check constraint).
// Keep 'bol' / 'pod' keys as-is; existing rows use them.
export const SCAN_DOC_TYPES = [
  { id: 'bol', label: 'Bill of lading', short: 'BOL' },
  { id: 'pod', label: 'Proof of delivery', short: 'POD' },
  { id: 'lumper_receipt', label: 'Lumper receipt', short: 'LUMPER' },
  { id: 'w9', label: 'W-9', short: 'W9' },
  { id: 'coi', label: 'Certificate of insurance', short: 'COI' },
  { id: 'mc_authority', label: 'MC authority letter', short: 'MC_AUTHORITY' },
];

export const DOC_TYPE_LABEL = Object.fromEntries([
  ['rate_confirmation', 'Rate confirmation'],
  ...SCAN_DOC_TYPES.map((t) => [t.id, t.label]),
]);

export function docTypeShort(id) {
  return SCAN_DOC_TYPES.find((t) => t.id === id)?.short || (id || 'scan').toUpperCase();
}
