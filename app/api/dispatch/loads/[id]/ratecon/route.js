// GET /api/dispatch/loads/<id>/ratecon → { url } (5-minute signed link to the load's newest rate confirmation).
// Rate con PDFs live in the load OWNER's private Storage folder; storage RLS only lets a user read their own folder.
// This route lets the owner, management and dispatchers open it; drivers and everyone else get 404 / 403.
//  * The caller's role comes from public.packet_role(owner) called WITH THE CALLER'S TOKEN, so PostgREST verifies
//    the JWT signature and the database decides the role (same as /api/packets/<id>/file).
//  * Only then does the service client read the document row (filtered by load_id AND the owner's user_id) and
//    sign the URL. The storage path is never taken from the request.
import { serviceClient, userClient, bearer, isAuthRejection } from '../../../../../lib/packetServer';
import { UUID } from '../../../../../lib/truckServer';
import { RATECON_ROLES } from '../../../../../lib/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const NOT_FOUND = { error: 'Load not found.' };

export async function GET(req, { params, deps } = {}) {
  const id = params?.id;
  if (!UUID.test(String(id || ''))) return json(NOT_FOUND, 404);
  const token = bearer(req);
  if (!token) return json({ error: 'Sign in first.' }, 401);
  const svc = deps?.sb || serviceClient();
  if (!svc) return json({ error: 'Rate con access isn’t set up on this server.' }, 503);
  const uc = (deps?.mkUserClient || userClient)(token);

  const { data: load, error: lErr } = await svc.from('loads').select('id, user_id').eq('id', id).maybeSingle();
  if (lErr) { console.error('[dispatch ratecon] load', lErr.message); return json({ error: 'Couldn’t open the rate con. Try again.' }, 500); }
  if (!load) return json(NOT_FOUND, 404);

  const { data: role, error: rErr } = await uc.rpc('packet_role', { p_owner: load.user_id });
  if (rErr) return isAuthRejection(rErr) || /PGRST30/.test(rErr.code || '') ? json({ error: 'Your sign-in expired. Please sign in again.', auth: true }, 401)
    : json({ error: 'Couldn’t check your access. Try again.', retry: true }, 503);
  if (!role) return json(NOT_FOUND, 404); // not on this company: don't confirm the load exists
  if (!RATECON_ROLES.has(role)) return json({ error: 'Drivers can’t open rate cons.' }, 403);

  const { data: docs, error: dErr } = await svc.from('documents').select('file_path, created_at')
    .eq('load_id', load.id).eq('user_id', load.user_id).eq('doc_type', 'rate_confirmation')
    .order('created_at', { ascending: false }).limit(1);
  if (dErr) { console.error('[dispatch ratecon] docs', dErr.message); return json({ error: 'Couldn’t open the rate con. Try again.' }, 500); }
  const path = docs?.[0]?.file_path;
  if (!path || !String(path).startsWith(`${load.user_id}/`)) return json({ error: 'This load has no rate con.' }, 404);
  const { data, error } = await svc.storage.from('documents').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { console.error('[dispatch ratecon] sign', error?.message); return json({ error: 'Couldn’t open the rate con. Try again.' }, 500); }
  return json({ url: data.signedUrl });
}
