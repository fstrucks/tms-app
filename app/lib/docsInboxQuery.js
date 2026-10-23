// Docs → Team inbox: recent linked load paperwork only (last 7 days, capped).
// Not the full team history. The vault page is the archive.
import { INBOX_RECENT_CAP, INBOX_RECENT_DAYS } from './docsInbox';
import { LOAD_VAULT_TYPES, canSeeTeamDoc, chunks, cmpDesc } from './loadVault';
import { companyMemberIds } from './loadVaultQuery';

const DOC_COLS = 'id,user_id,load_id,doc_type,file_path,original_filename,created_at,ai_extracted_data';
const LOAD_COLS = 'id,user_id,broker_load_number,broker_name,status,assigned_driver_user_id,show_rate_to_driver,created_at';

async function recentOf(svc, scope, since) {
  const run = async (narrow) => {
    let q = narrow(scope(svc.from('documents').select(DOC_COLS)));
    q = q.gte('created_at', since).order('created_at', { ascending: false }).limit(40);
    const { data, error } = await q;
    if (error) return { error };
    return { docs: data || [] };
  };
  const parts = await Promise.all([
    run((q) => q.in('doc_type', LOAD_VAULT_TYPES)),
    run((q) => q.like('doc_type', 'other:%')),
    run((q) => q.is('doc_type', null)),
  ]);
  for (const p of parts) if (p.error) return p;
  const map = new Map();
  for (const p of parts) for (const d of p.docs) if (d?.id) map.set(d.id, d);
  return { docs: [...map.values()] };
}

export async function selectInboxTeamDocs(svc, { ownerId, role, userId, now = Date.now() } = {}) {
  const since = new Date(now - INBOX_RECENT_DAYS * 864e5).toISOString();
  const driver = !(role === 'owner' || role === 'management' || role === 'dispatcher');
  let docs = [];
  if (driver) {
    const { data, error } = await svc.from('loads').select(LOAD_COLS).eq('user_id', ownerId).eq('assigned_driver_user_id', userId).limit(300);
    if (error) return { error };
    const ids = (data || []).map((l) => l.id);
    for (const part of chunks(ids, 80)) {
      const got = await recentOf(svc, (q) => q.in('load_id', part), since);
      if (got.error) return got;
      docs.push(...got.docs);
    }
  } else {
    const members = await companyMemberIds(svc, ownerId);
    if (members.error) return members;
    const got = await recentOf(svc, (q) => q.in('user_id', members.ids).not('load_id', 'is', null), since);
    if (got.error) return got;
    docs = got.docs;
    const loose = await svc.from('documents').select(DOC_COLS).in('user_id', members.ids)
      .eq('doc_type', 'scale_ticket').is('load_id', null).gte('created_at', since).limit(20);
    if (!loose.error) docs.push(...(loose.data || []));
  }
  const map = new Map();
  for (const d of docs) if (d?.id) map.set(d.id, d);
  docs = [...map.values()].sort(cmpDesc).slice(0, 80);
  const ticketIds = docs.filter((d) => !d.load_id).map((d) => d.id);
  let tickets = [];
  if (ticketIds.length) {
    const tk = await svc.from('scale_tickets').select('document_id, load_id').eq('user_id', ownerId).in('document_id', ticketIds);
    if (!tk.error) tickets = tk.data || [];
  }
  const ticketLoad = new Map(tickets.filter((t) => t.document_id && t.load_id).map((t) => [t.document_id, t.load_id]));
  docs = docs.map((d) => (d.load_id || !ticketLoad.get(d.id) ? d : { ...d, load_id: ticketLoad.get(d.id) }));
  const loadIds = [...new Set(docs.map((d) => d.load_id).filter(Boolean))];
  let loads = [];
  for (const part of chunks(loadIds, 80)) {
    const { data, error } = await svc.from('loads').select(LOAD_COLS).eq('user_id', ownerId).in('id', part);
    if (error) return { error };
    loads.push(...(data || []));
  }
  const loadsById = new Map(loads.map((l) => [l.id, l]));
  const visible = docs.filter((d) => canSeeTeamDoc({ role, userId, ownerId, doc: d, load: loadsById.get(d.load_id) || null }))
    .sort(cmpDesc)
    .slice(0, INBOX_RECENT_CAP);
  return { documents: visible, loadsById };
}
