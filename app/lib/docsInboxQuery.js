// Docs → Team "Needs attention": teammates' uploads that nobody has filed yet.
// Office only (owner, management, dispatcher). Drivers do not see another person's unlinked file.
// Email rate cons stay on Mine: the office already receives them through the email read policy,
// and Mine is where they are reviewed. Linked paperwork stays in the vaults.
import { INBOX_ATTENTION_CAP, INBOX_ATTENTION_FETCH, selectNeedsAttention } from './docsInbox';
import { chunks, cmpDesc } from './loadVault';
import { companyMemberIds } from './loadVaultQuery';

const FULL_COLS = 'id,user_id,load_id,truck_id,service_record_id,doc_type,file_path,original_filename,created_at,ai_extracted_data,source,extraction_status,extraction_error,handled_at';
const MID_COLS = 'id,user_id,load_id,truck_id,service_record_id,doc_type,file_path,original_filename,created_at,ai_extracted_data,source,extraction_status,extraction_error';
const BASE_COLS = 'id,user_id,load_id,truck_id,doc_type,file_path,original_filename,created_at,ai_extracted_data,source';

const OFFICE = new Set(['owner', 'management', 'dispatcher']);

async function unassignedOf(svc, userIds) {
  const run = (cols, service, handled) => {
    let q = svc.from('documents').select(cols).in('user_id', userIds).is('load_id', null).is('truck_id', null);
    if (service) q = q.is('service_record_id', null);
    if (handled) q = q.is('handled_at', null);
    return q.not('file_path', 'like', '%/checklist/%').not('file_path', 'like', '%/company/%')
      .order('created_at', { ascending: false }).limit(INBOX_ATTENTION_FETCH);
  };
  let res = await run(FULL_COLS, true, true);
  if (res.error?.code === '42703') res = await run(MID_COLS, true, false);
  if (res.error?.code === '42703') res = await run(BASE_COLS, false, false);
  return res;
}

export async function selectInboxTeamDocs(svc, { ownerId, role, userId } = {}) {
  if (!OFFICE.has(role)) return { documents: [], more: false, loadsById: new Map() };
  const members = await companyMemberIds(svc, ownerId);
  if (members.error) return members;
  const ids = members.ids.filter((id) => id && id !== userId);
  if (!ids.length) return { documents: [], more: false, loadsById: new Map() };
  let docs = [];
  for (const part of chunks(ids, 80)) {
    const got = await unassignedOf(svc, part);
    if (got.error) return got;
    docs.push(...(got.data || []));
  }
  const map = new Map();
  for (const d of docs) if (d?.id) map.set(d.id, d);
  docs = [...map.values()].sort(cmpDesc);
  const docIds = docs.map((d) => d.id);
  let tickets = [];
  for (const part of chunks(docIds, 80)) {
    const tk = await svc.from('scale_tickets').select('document_id, load_id, truck_id, trailer_id, confirmed').eq('user_id', ownerId).in('document_id', part);
    if (!tk.error) tickets.push(...(tk.data || []));
  }
  // Drop email rows so a teammate's rate con is not listed twice (it is already on Mine for the office).
  const matched = selectNeedsAttention(docs, tickets).filter((d) => d.source !== 'email');
  return { documents: matched.slice(0, INBOX_ATTENTION_CAP), more: matched.length > INBOX_ATTENTION_CAP, loadsById: new Map() };
}
