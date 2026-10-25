// Cheap counts for the Docs tiles: head counts and a bounded driver-file read.
// No full document list. Maintenance is not counted here; that RPC stays behind its flag.
import { VAULT_TYPE_IDS } from './companyDocs';
import { LOAD_VAULT_TYPES, chunks, isLoadVaultDoc, pageLoadVault } from './loadVault';
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

const LOOSE_COLS = 'id, doc_type, file_path, load_id, truck_id, service_record_id, source, extraction_error, ai_extracted_data, created_at, handled_at';
const LOOSE_COLS_MID = 'id, doc_type, file_path, load_id, truck_id, service_record_id, source, extraction_error, ai_extracted_data, created_at';
const LOOSE_COLS_BASE = 'id, doc_type, file_path, load_id, truck_id, source, extraction_error, ai_extracted_data, created_at';
const LOOSE_BATCH = 200;

// Own unassigned rows that still need attention are inside the head count above.
// Subtract them with the same predicate the list uses. handled_at rows stay in the tile.
async function countOwnAttention(svc, userId) {
  const seen = new Set();
  let total = 0;
  let before = null;
  let tier = 0;
  const colsOf = [LOOSE_COLS, LOOSE_COLS_MID, LOOSE_COLS_BASE];
  for (let guard = 0; guard < 25; guard += 1) {
    let q = svc.from('documents').select(colsOf[tier]).eq('user_id', userId).is('load_id', null).is('truck_id', null);
    if (tier < 2) q = q.is('service_record_id', null);
    if (tier === 0) q = q.is('handled_at', null);
    if (before) q = q.lt('created_at', before);
    const res = await q.order('created_at', { ascending: false }).limit(LOOSE_BATCH);
    if (res.error?.code === '42703' && tier < 2) { tier += 1; continue; }
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

const TICKET_PAGE = 200;
const LINKED_DOC_COLS = 'id,user_id,load_id,doc_type,source,handled_at,file_path,created_at';
const LINKED_DOC_COLS_BASE = 'id,user_id,load_id,doc_type,source,file_path,created_at';

// Teammate paperwork filed only through a scale ticket: documents.load_id is still null,
// but scale_tickets.load_id points at a company load, so the vault list shows the row.
// Own rows are already in the head count. Page by ticket id so a set larger than 200 is not cut off.
async function countTicketLinkedShown(svc, { ownerId, role, userId, memberIds }) {
  const others = memberIds.filter((id) => id && id !== userId);
  if (!others.length) return 0;
  const tickets = [];
  const seenTickets = new Set();
  let beforeId = null;
  for (let guard = 0; guard < 50; guard += 1) {
    let q = svc.from('scale_tickets')
      .select('id,document_id,load_id,truck_id,trailer_id,confirmed')
      .eq('user_id', ownerId)
      .not('document_id', 'is', null)
      .not('load_id', 'is', null);
    if (beforeId) q = q.lt('id', beforeId);
    const res = await q.order('id', { ascending: false }).limit(TICKET_PAGE);
    if (res.error) return null;
    const rows = res.data || [];
    if (!rows.length) break;
    let added = 0;
    for (const t of rows) {
      if (!t?.document_id || seenTickets.has(t.document_id)) continue;
      seenTickets.add(t.document_id);
      added += 1;
      tickets.push(t);
    }
    if (!added || rows.length < TICKET_PAGE) break;
    const lastId = rows[rows.length - 1]?.id;
    if (!lastId || lastId === beforeId) break;
    beforeId = lastId;
  }
  if (!tickets.length) return 0;
  const docs = [];
  const seenDocs = new Set();
  let cols = LINKED_DOC_COLS;
  for (const users of chunks(others, 80)) {
    for (const part of chunks(tickets.map((t) => t.document_id), 80)) {
      let res = await svc.from('documents').select(cols).in('id', part).in('user_id', users).is('load_id', null);
      if (res.error?.code === '42703' && cols !== LINKED_DOC_COLS_BASE) {
        cols = LINKED_DOC_COLS_BASE;
        res = await svc.from('documents').select(cols).in('id', part).in('user_id', users).is('load_id', null);
      }
      if (res.error) return null;
      for (const d of res.data || []) {
        if (!d?.id || seenDocs.has(d.id)) continue;
        seenDocs.add(d.id);
        docs.push(d);
      }
    }
  }
  if (!docs.length) return 0;
  const loads = [];
  for (const part of chunks([...new Set(tickets.map((t) => t.load_id).filter(Boolean))], 80)) {
    const ld = await svc.from('loads').select('id,user_id,assigned_driver_user_id,show_rate_to_driver').eq('user_id', ownerId).in('id', part);
    if (ld.error) return null;
    loads.push(...(ld.data || []));
  }
  return pageLoadVault({ docs, loads, ticketLoads: tickets, role, userId, ownerId, limit: docs.length }).rows.length;
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
    if (raw == null) return null;
    const extra = await countTicketLinkedShown(svc, { ownerId, role, userId, memberIds });
    return extra == null ? null : Math.max(0, raw - ownAttention + extra);
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
  if (raw == null) return null;
  const extra = await countTicketLinkedShown(svc, { ownerId, role, userId, memberIds });
  return extra == null ? null : Math.max(0, raw - ownAttention + extra);
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
