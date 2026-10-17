import { serviceClient, userClient, bearer, isAuthRejection } from '../../../../lib/packetServer';
import { UPLOAD_TYPES } from '../../../../lib/docTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
export const DOC_TYPE_EDIT_ROLES = new Set(['owner', 'management']);

// Body: { docType }. Owner/management of the document's company only. Changes the type ONLY:
// never runs extraction (the page offers an optional "Read as rate con" when the new type is rate con).
export async function PATCH(req, { params, deps } = {}) {
  const token = bearer(req);
  if (!token) return json({ error: 'Sign in again.' }, 401);
  if (!UUID.test(params?.id || '')) return json({ error: 'Document not found.' }, 404);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!UPLOAD_TYPES.some((t) => t.id === b?.docType)) return json({ error: 'Pick a document type.' }, 422);
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const uc = (deps?.mkUserClient || userClient)(token);
  const { data: u, error: uErr } = await uc.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503);
  if (!u?.user) return json({ error: 'Sign in again.' }, 401);
  const { data: doc, error } = await sb.from('documents').select('id,user_id,doc_type').eq('id', params.id).maybeSingle();
  if (error) return json({ error: 'Could not load the document.' }, 500);
  if (!doc) return json({ error: 'Document not found.' }, 404);
  const { data: role } = await uc.rpc('packet_role', { p_owner: doc.user_id });
  if (!role) return json({ error: 'Document not found.' }, 404);
  if (!DOC_TYPE_EDIT_ROLES.has(role)) return json({ error: 'Only the owner or management can change a document’s type.' }, 403);
  if (doc.doc_type === b.docType) return json({ ok: true, docType: doc.doc_type, document: { id: doc.id, doc_type: doc.doc_type }, unchanged: true });
  const up = await sb.from('documents').update({ doc_type: b.docType }).eq('id', doc.id);
  if (up.error) return json({ error: 'Could not change the type.' }, 500);
  const { data: saved } = await sb.from('documents').select('id,doc_type').eq('id', doc.id).maybeSingle();
  const docType = saved?.doc_type || b.docType;
  return json({ ok: true, docType, document: { id: doc.id, doc_type: docType }, offerRead: docType === 'rate_confirmation' });
}
