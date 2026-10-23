// Server queries for the load-docs vault. Each query is bounded (type + date + uploader or load id).
// Paging walks older rows with a cursor. It does not select the whole documents table.
import {
  LOAD_VAULT_PAGE, LOAD_VAULT_TYPES, chunks, cmpDesc, cursorOf, escapeIlike, isOlderThan,
  normalizeFilters, pageLoadVault, parseCursor,
} from './loadVault';

export const VAULT_BATCH = 60;
const DOC_COLS = 'id,user_id,load_id,doc_type,file_path,original_filename,created_at,ai_extracted_data';
const LOAD_COLS = 'id,user_id,broker_load_number,broker_name,status,assigned_driver_user_id,show_rate_to_driver,created_at';

const endOfDay = (day) => (day && !day.includes('T') ? `${day}T23:59:59.999Z` : day);

export async function companyMemberIds(svc, ownerId) {
  const { data, error } = await svc.from('company_members')
    .select('user_id, company_profiles!inner(owner_id)')
    .eq('company_profiles.owner_id', ownerId)
    .limit(200);
  if (error) return { error };
  const ids = new Set([ownerId]);
  for (const row of data || []) if (row?.user_id) ids.add(row.user_id);
  return { ids: [...ids] };
}

function typeFns(type) {
  if (type === 'other') return [(q) => q.like('doc_type', 'other:%')];
  if (type) return [(q) => q.eq('doc_type', type)];
  return [
    (q) => q.in('doc_type', LOAD_VAULT_TYPES),
    (q) => q.like('doc_type', 'other:%'),
    (q) => q.is('doc_type', null),
  ];
}

function bound(q, { cursor, filters, batch }) {
  let x = q.order('created_at', { ascending: false }).order('id', { ascending: false });
  if (filters.from) x = x.gte('created_at', filters.from);
  if (filters.to) x = x.lte('created_at', endOfDay(filters.to));
  if (cursor?.created_at) x = x.lte('created_at', cursor.created_at);
  return x.limit(batch);
}

async function runScoped(svc, scopes, filters, cursor, batch) {
  const jobs = [];
  for (const scope of scopes) {
    for (const typeOf of typeFns(filters.type)) {
      jobs.push(bound(typeOf(scope(svc.from('documents').select(DOC_COLS))), { cursor, filters, batch }));
    }
  }
  const lists = await Promise.all(jobs);
  for (const r of lists) if (r.error) return { error: r.error };
  const map = new Map();
  for (const r of lists) for (const d of r.data || []) if (d?.id && isOlderThan(d, cursor)) map.set(d.id, d);
  return { docs: [...map.values()].sort(cmpDesc).slice(0, batch) };
}

async function loadsByIds(svc, ownerId, ids) {
  const out = [];
  for (const part of chunks([...new Set((ids || []).filter(Boolean))], 80)) {
    const { data, error } = await svc.from('loads').select(LOAD_COLS).eq('user_id', ownerId).in('id', part);
    if (error) return { error };
    out.push(...(data || []));
  }
  return { loads: out };
}

async function searchLoads(svc, ownerId, filters, driverUserId) {
  let q = svc.from('loads').select(LOAD_COLS).eq('user_id', ownerId);
  if (driverUserId) q = q.eq('assigned_driver_user_id', driverUserId);
  if (filters.load) q = q.ilike('broker_load_number', `%${escapeIlike(filters.load)}%`);
  if (filters.broker) q = q.ilike('broker_name', `%${escapeIlike(filters.broker)}%`);
  const { data, error } = await q.limit(100);
  if (error) return { error };
  return { loads: data || [] };
}

async function assignedLoads(svc, ownerId, userId) {
  const { data, error } = await svc.from('loads').select(LOAD_COLS).eq('user_id', ownerId).eq('assigned_driver_user_id', userId).limit(500);
  if (error) return { error };
  return { loads: data || [] };
}

async function ticketsFor(svc, ownerId, docs) {
  const ids = (docs || []).map((d) => d.id).filter(Boolean);
  const out = [];
  for (const part of chunks(ids, 80)) {
    const { data, error } = await svc.from('scale_tickets').select('document_id, load_id').eq('user_id', ownerId).in('document_id', part);
    if (error) return { tickets: [] };
    out.push(...(data || []));
  }
  return { tickets: out };
}

function scopesFor({ driver, userId, memberIds, loadIds, text }) {
  if (text) {
    const scopes = [];
    for (const part of chunks(loadIds || [], 80)) scopes.push((q) => q.in('load_id', part));
    scopes.push((q) => q.eq('user_id', userId).is('load_id', null));
    return scopes.length ? scopes : [(q) => q.eq('user_id', userId).is('load_id', null)];
  }
  if (driver) {
    const scopes = [(q) => q.eq('user_id', userId)];
    for (const part of chunks(loadIds || [], 80)) scopes.push((q) => q.in('load_id', part));
    return scopes;
  }
  return [(q) => q.in('user_id', memberIds)];
}

export async function fetchVaultPage(svc, { ownerId, role, userId, filters = {}, cursor = null, limit = LOAD_VAULT_PAGE } = {}) {
  const lim = Math.min(Math.max(Number(limit) || LOAD_VAULT_PAGE, 1), 50);
  const f = normalizeFilters(filters);
  const driver = role === 'driver';
  const members = await companyMemberIds(svc, ownerId);
  if (members.error) return { error: members.error };
  const text = !!(f.load || f.broker);
  let known = [];
  let loadIds = null;
  if (text) {
    const found = await searchLoads(svc, ownerId, f, driver ? userId : null);
    if (found.error) return { error: found.error };
    known = found.loads;
    loadIds = known.map((l) => l.id);
  } else if (driver) {
    const found = await assignedLoads(svc, ownerId, userId);
    if (found.error) return { error: found.error };
    known = found.loads;
    loadIds = known.map((l) => l.id);
  }
  const scopes = scopesFor({ driver, userId, memberIds: members.ids, loadIds, text });
  let scan = parseCursor(cursor);
  const collected = [];
  let guard = 0;
  let more = false;
  let batchWasFull = false;
  while (collected.length < lim && guard < 8) {
    guard += 1;
    const batch = await runScoped(svc, scopes, f, scan, VAULT_BATCH);
    if (batch.error) return { error: batch.error };
    const docs = batch.docs || [];
    if (!docs.length) { batchWasFull = false; break; }
    const { tickets } = await ticketsFor(svc, ownerId, docs);
    const needIds = [
      ...docs.map((d) => d.load_id),
      ...tickets.map((t) => t.load_id),
    ];
    const extra = await loadsByIds(svc, ownerId, needIds);
    if (extra.error) return { error: extra.error };
    const loads = [...known, ...(extra.loads || [])];
    const room = lim - collected.length;
    const page = pageLoadVault({
      docs, loads, ticketLoads: tickets, role, userId, ownerId, filters: f, cursor: scan, limit: room + 1,
    });
    collected.push(...page.rows.slice(0, room));
    batchWasFull = docs.length >= VAULT_BATCH;
    if (page.rows.length > room) { more = true; break; }
    if (!batchWasFull) break;
    const last = docs[docs.length - 1];
    const next = { created_at: last.created_at, id: last.id };
    if (scan && next.created_at === scan.created_at && next.id === scan.id) break;
    scan = next;
    if (guard >= 8) { more = true; break; }
  }
  if (!more && collected.length === lim && batchWasFull) {
    const probe = await runScoped(svc, scopes, f, { created_at: collected[collected.length - 1].doc.created_at, id: collected[collected.length - 1].doc.id }, 20);
    if (!probe.error && probe.docs?.length) {
      const { tickets } = await ticketsFor(svc, ownerId, probe.docs);
      const extra = await loadsByIds(svc, ownerId, [...probe.docs.map((d) => d.load_id), ...tickets.map((t) => t.load_id)]);
      const page = pageLoadVault({
        docs: probe.docs, loads: [...known, ...(extra.loads || [])], ticketLoads: tickets,
        role, userId, ownerId, filters: f,
        cursor: { created_at: collected[collected.length - 1].doc.created_at, id: collected[collected.length - 1].doc.id },
        limit: 1,
      });
      more = page.rows.length > 0;
    }
  }
  const rows = collected.slice(0, lim);
  return { rows, nextCursor: more && rows.length ? cursorOf(rows[rows.length - 1].doc) : null };
}
