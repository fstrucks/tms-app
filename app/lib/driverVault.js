// Driver files (CDL, medical card, MVR, drug test, and the other per-driver checklist files).
// Grouped by driver. A driver login only gets the driver row linked to that sign-in.
import { isCompanyDocType } from './docTypes';
import { CHECKLIST_ITEMS } from './setupCatalog';
import { scopeIdOf } from './setupProgress';

export const DRIVER_VAULT_TYPES = [
  { id: 'cdl', label: 'CDL' },
  { id: 'medical_card', label: 'Medical card' },
  { id: 'mvr', label: 'MVR' },
  { id: 'prehire_mvr', label: 'Pre-hire driving record' },
  { id: 'annual_mvr', label: 'Annual driving record' },
  { id: 'drug_test', label: 'Drug test' },
  { id: 'preemployment_drug', label: 'Pre-employment drug test' },
  { id: 'clearinghouse_queries', label: 'Clearinghouse query' },
];
export const DRIVER_VAULT_TYPE_IDS = DRIVER_VAULT_TYPES.map((t) => t.id);
export const DRIVER_VAULT_FETCH_CAP = 300;

const DRIVER_ITEM_KEYS = new Set(CHECKLIST_ITEMS.filter((i) => i.scope === 'driver' && !i.echoOf).map((i) => i.key));

export function isDriverVaultDoc(doc, statuses = []) {
  if (!doc || doc.doc_type === 'receipt' || isCompanyDocType(doc.doc_type)) return false;
  if (DRIVER_VAULT_TYPE_IDS.includes(doc.doc_type)) return true;
  return (statuses || []).some((s) => s.document_id === doc.id && s.driver_id && DRIVER_ITEM_KEYS.has(s.item_key));
}

export function driversForRole(drivers, role, userId) {
  const list = drivers || [];
  if (role !== 'driver') return list;
  return list.filter((d) => d?.auth_user_id && d.auth_user_id === userId);
}

function publicDriver(d) {
  return {
    id: d.id,
    name: String(d.name || 'Driver').slice(0, 120),
    active: d.active !== false,
    cdlExpiry: d.cdl_expiry || null,
    medCardExpiry: d.med_card_expiry || null,
  };
}

function driverIdFor(doc, drivers, statuses) {
  const ids = new Set((drivers || []).map((d) => d.id));
  const scope = scopeIdOf(doc);
  if (scope && ids.has(scope)) return scope;
  const inPath = (drivers || []).find((d) => d.id && String(doc?.file_path || '').includes(`/${d.id}/`));
  if (inPath) return inPath.id;
  const st = (statuses || []).find((s) => s.document_id === doc?.id && s.driver_id && ids.has(s.driver_id));
  return st?.driver_id || null;
}

export function groupDriverVault({ drivers, documents, statuses, role, userId } = {}) {
  const visible = driversForRole(drivers, role, userId)
    .slice()
    .sort((a, b) => (Number(b.active !== false) - Number(a.active !== false)) || String(a.name || '').localeCompare(String(b.name || '')));
  const docs = (documents || []).filter((d) => isDriverVaultDoc(d, statuses));
  const byDriver = new Map(visible.map((d) => [d.id, []]));
  const unassigned = [];
  for (const doc of docs) {
    const id = driverIdFor(doc, visible, statuses);
    if (id && byDriver.has(id)) byDriver.get(id).push(doc);
    else if (role !== 'driver') unassigned.push(doc);
  }
  const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  return {
    groups: visible.map((d) => ({ driver: publicDriver(d), files: (byDriver.get(d.id) || []).sort(byNewest) })),
    unassigned: unassigned.sort(byNewest),
  };
}

export function countDriverVaultFiles(grouped) {
  if (!grouped) return 0;
  return (grouped.groups || []).reduce((n, g) => n + (g.files || []).length, 0) + (grouped.unassigned || []).length;
}
