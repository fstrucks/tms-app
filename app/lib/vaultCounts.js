// Cheap counts for the Docs tiles: head counts and a bounded driver-file read.
// No full document list. Maintenance is not counted here; that RPC stays behind its flag.
import { VAULT_TYPE_IDS } from './companyDocs';
import { LOAD_VAULT_TYPES, chunks } from './loadVault';
import { companyMemberIds } from './loadVaultQuery';
import { loadDriverVault } from './driverVaultQuery';

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

async function countLoadDocs(svc, { ownerId, role, userId, memberIds }) {
  const driver = role === 'driver';
  if (!driver) {
    const others = memberIds.filter((id) => id !== userId);
    const makes = [
      ...typeHeads(svc, (q) => q.eq('user_id', userId)),
    ];
    if (others.length) {
      makes.push(...typeHeads(svc, (q) => q.in('user_id', others).not('load_id', 'is', null)));
    }
    return sumHeads(makes);
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
  return sumHeads(makes);
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
