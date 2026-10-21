// Category for a stored documents.doc_type. Names match the setup checklist groups.
// doc_type stays plain text; new keys need no SQL. 'other:<name>' stays uncategorized.

export const DOC_CATEGORY_NAMES = [
  'Company & Authority',
  'Insurance',
  'Taxes & Fuel Tax',
  'Drug & Alcohol',
  'Driver Files',
  'Truck & Trailer',
  'Permits',
  'In-Cab Binder',
  'Truck Equipment',
  'Loads & Paperwork',
  'Billing & Factoring',
  'Hazmat (only if hauling hazmat)',
];

const BY_TYPE = {
  usdot_mcs150: 'Company & Authority',
  mc_authority: 'Company & Authority',
  boc3: 'Company & Authority',
  ucr: 'Company & Authority',
  formation: 'Company & Authority',
  carrier_lease: 'Company & Authority',
  coi: 'Insurance',
  mcs90: 'Insurance',
  w9: 'Taxes & Fuel Tax',
  ifta_license: 'Taxes & Fuel Tax',
  form_2290: 'Taxes & Fuel Tax',
  da_consortium: 'Drug & Alcohol',
  da_policy: 'Drug & Alcohol',
  clearinghouse: 'Drug & Alcohol',
  medical_card: 'Driver Files',
  cdl: 'Driver Files',
  cab_card: 'Truck & Trailer',
  irp_account: 'Truck & Trailer',
  title: 'Truck & Trailer',
  annual_inspection: 'Truck & Trailer',
  equipment_lease: 'Truck & Trailer',
  permit: 'Permits',
  rate_confirmation: 'Loads & Paperwork',
  bol: 'Loads & Paperwork',
  pod: 'Loads & Paperwork',
  lumper_receipt: 'Loads & Paperwork',
  scale_ticket: 'Loads & Paperwork',
  noa: 'Billing & Factoring',
};

export function categoryForDocType(docType) {
  if (!docType || String(docType).startsWith('other:')) return null;
  return BY_TYPE[docType] || null;
}
