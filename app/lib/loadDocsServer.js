// Server side of load paperwork (PR #110). documents RLS stays own-rows (uploader only), so a driver's BOL is
// invisible to the owner and a driver can't link it to the owner's load. These endpoints check the caller's
// company role first (truckCtx → packet_role) and then read/write with the service client, always filtered to the
// company (loads.user_id = ownerId; document uploader = owner or a member of the owner's company).
import { truckCtx, json, UUID } from './truckServer.js';
import { serviceClient } from './packetServer.js';

export { json, UUID };
const LOAD_COLS = 'id,user_id,broker_load_number,broker_name,status,assigned_driver_user_id,show_rate_to_driver,notes,created_at';
export const DOC_COLS = 'id,user_id,load_id,doc_type,file_path,original_filename,created_at,ai_extracted_data';

// → { c, svc } | { res }
export async function loadDocsCtx(req, deps = {}) {
  const c = await truckCtx(req, deps);
  if (c.res) return c;
  const svc = deps.sb || (deps.mkService || serviceClient)();
  if (!svc) return { res: json({ error: 'Documents aren’t set up on this server yet.' }, 503) };
  return { c, svc };
}

export async function companyLoad(svc, ownerId, loadId) {
  if (!UUID.test(loadId || '')) return null;
  const { data } = await svc.from('loads').select(`${LOAD_COLS}, stops(*)`).eq('id', loadId).eq('user_id', ownerId).maybeSingle();
  return data || null;
}

// The uploader must be the owner or a member of the owner's company.
export async function docInCompany(svc, ownerId, doc) {
  if (!doc) return false;
  if (doc.user_id === ownerId) return true;
  const { data } = await svc.from('company_members').select('user_id, company_profiles!inner(owner_id)').eq('user_id', doc.user_id).eq('company_profiles.owner_id', ownerId).limit(1);
  return !!data?.length;
}

export async function companyDoc(svc, ownerId, docId) {
  if (!UUID.test(docId || '')) return null;
  const { data } = await svc.from('documents').select(DOC_COLS).eq('id', docId).maybeSingle();
  return data && (await docInCompany(svc, ownerId, data)) ? data : null;
}

// Loads the caller may pick in "Link to load": drivers get their assigned loads only.
export async function pickableLoads(svc, ownerId, { role, userId }) {
  let q = svc.from('loads').select(`${LOAD_COLS}, stops(*)`).eq('user_id', ownerId).order('created_at', { ascending: false }).limit(100);
  if (!(role === 'owner' || role === 'management' || role === 'dispatcher')) q = q.eq('assigned_driver_user_id', userId);
  const { data } = await q;
  return data || [];
}
