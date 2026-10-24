// Cheap counts for the Docs tiles: head counts and a bounded driver-file read.
// No full document list. Maintenance is not counted here; that RPC stays behind its flag.
import { VAULT_TYPE_IDS } from './companyDocs';
import { LOAD_VAULT_TYPES, chunks, isLoadVaultDoc } from './loadVault';
import { companyMemberIds } from './loadVaultQuery';
import { loadDriverVault } from './driverVaultQuery';
import { needsAttention } from './docsInbox';

async function head(q) {
  const { count, error } = await q;
  if (error) return null;
  return count || 0;
}

async function sumHeads(makes) {
  let total = 0;
  for (const make of makes) {
    const n = await head(make());
    if (n == null) return null;
    total += n;
  }
  return total;
}

function typeHeads(svc, narrow) {
  const base = () => narrow(svc.from('documents').select('id', { count: 'exact', head: true }));
  return [
    () => base().in('doc_type', LOAD_VAULT_TYPES),
    () => base().like('doc_type', 'other:%'),
    () => base().is('doc_type', null),
  ];
}

const LOOSE_COLS = 'id, doc_type, file_path, load_id, truck_id, service_record_id, source, extraction_error, ai_extracted_data, created_at';
const LOOSE_COLS_BASE = 'id, doc_type, file_path, load_id, truck_id, source, extraction_error, ai_extracted_data, created_at';
const LOOSE_BATCH = 200;

// Own unassigned rows that still need attention are inside the head count above.
// Subtract them with the same predicate the list uses. No new column.
async function countOwnAttention(svc, userId) {
  const seen = new Set();
  let total = 0;
  let before = null;
  let service = true;
  for (let guard = 0; guard < 25; guard += 1) {
    let q = svc.from('documents').select(service ? LOOSE_COLS : LOOSE_COLS_BASE).eq('user_id', userId).is('load_id', null).is('truck_id', null);
    if (service) q = q.is('service_record_id', null);
    if (before) q = q.lt('created_at', before);
    const res = await q.order('created_at', { ascending: false }).limit(LOOSE_BATCH);
    if (res.error?.code === '42703' && service) { service = false; continue; }
    if (res.error) return null;
    const docs = res.data || [];
    if (!docs.length) break;
    const ids = docs.map((d) => d.id).filter((id) => id && !seen.has(id));
    const tickets = new Map();
    for (const part of chunks(ids, 80)) {
      const tk = await svc.from('scale_tickets').select('document_id, load_id, truck_id, trailer_id, confirmed').in('document_id', part);
      if (tk.error) return null;
      for (const t of tk.data || []) if (t?.document_id && !tickets.has(t.document_id)) tickets.set(t.document_id, t);
    }
    let added = 0;
    for (const d of docs) {
      if (!d?.id || seen.has(d.id)) continue;
      seen.add(d.id);
      added += 1;
      if (isLoadVaultDoc(d) && needsAttention(d, tickets.get(d.id) || null)) total += 1;
    }
    if (!added || docs.length < LOOSE_BATCH) break;
    const last = docs[docs.length - 1]?.created_at;
    if (!last || last === before) break;
    before = last;
  }
  return total;
}

async function countLoadDocs(svc, { ownerId, role, userId, memberIds }) {
  const driver = role === 'driver';
  const ownAttention = await countOwnAttention(svc, userId);
  if (ownAttention == null) return null;
  if (!driver) {
    const others = memberIds.filter((id) => id !== userId);
    const makes = [
      ...typeHeads(svc, (q) => q.eq('user_id', userId)),
    ];
    if (others.length) {
      makes.push(...typeHeads(svc, (q) => q.in('user_id', others).not('load_id', 'is', null)));
    }
    const raw = await sumHeads(makes);
    return raw == null ? null : Math.max(0, raw - ownAttention);
  }
  const { data, error } = await svc.from('loads').select('id,show_rate_to_driver').eq('user_id', ownerId).eq('assigned_driver_user_id', userId).limit(500);
  if (error) return null;
  const loads = data || [];
  const all = loads.map((l) => l.id);
  const show = loads.filter((l) => l.show_rate_to_driver).map((l) => l.id);
  const makes = [...typeHeads(svc, (q) => q.eq('user_id', userId))];
  const nonRate = LOAD_VAULT_TYPES.filter((t) => t !== 'rate_confirmation');
  for (const part of chunks(all, 80)) {
    makes.push(() => svc.from('documents').select('id', { count: 'exact', head: true }).in('load_id', part).in('doc_type', nonRate).neq('user_id', userId));
    makes.push(() => svc.from('documents').select('id', { count: 'exact', head: true }).in('load_id', part).like('doc_type', 'other:%').neq('user_id', userId));
    makes.push(() => svc.from('documents').select('id', { count: 'exact', head: true }).in('load_id', part).is('doc_type', null).neq('user_id', userId));
  }
  for (const part of chunks(show, 80)) {
    makes.push(() => svc.from('documents').select('id', { count: 'exact', head: true }).in('load_id', part).eq('doc_type', 'rate_confirmation').neq('user_id', userId));
  }
  const raw = await sumHeads(makes);
  return raw == null ? null : Math.max(0, raw - ownAttention);
}

async function countCompanyDocs(svc, ownerId) {
  const { data, error } = await svc.from('documents').select('doc_type').eq('user_id', ownerId).in('doc_type', VAULT_TYPE_IDS).limit(80);
  if (error) return null;
  return new Set((data || []).map((d) => d.doc_type)).size;
}

export async function vaultTileCounts(svc, { ownerId, role, userId, profileId } = {}) {
  const members = await companyMemberIds(svc, ownerId);
  if (members.error) return { error: members.error };
  const [loadDocs, driver, companyDocs] = await Promise.all([
    countLoadDocs(svc, { ownerId, role, userId, memberIds: members.ids }),
    loadDriverVault(svc, { ownerId, role, userId, profileId }),
    countCompanyDocs(svc, ownerId),
  ]);
  if (driver.error) return { error: driver.error };
  return {
    loadDocs,
    driverDocs: driver.count ?? 0,
    driverDocsCapped: !!driver.capped,
    companyDocs,
  };
}
