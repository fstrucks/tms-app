// GET /api/dispatch/loads/<id>/ratecon → { url } (5-minute signed link to the load's newest rate confirmation).
// Same document as the load page Documents section: the newest rate_confirmation linked to this load that the
// caller may see. Drivers and everyone else get 404 / 403. The file itself lives in the UPLOADER's Storage
// folder (`{user_id}/{timestamp}-{name}`, same scheme as scanUpload); storage RLS only lets a user read their
// own folder, so this route signs with the service client after the checks below.
//  * The caller's role comes from public.packet_role(owner) called WITH THE CALLER'S TOKEN, so PostgREST verifies
//    the JWT signature and the database decides the role (same as /api/packets/<id>/file).
//  * Only then does the service client read rate cons linked to the load (any company uploader, not only the
//    load owner), keep those whose path is in the uploader's folder, and sign the newest. The storage path is
//    never taken from the request.
//  * Auth: the Bearer header (in-app button), else the session cookie (URL opened directly in a tab; see
//    lib/authCookie). Both are verified the same way. Signed out → 401, driver → 403, not on the company → 404.
import { serviceClient, userClient, bearer, isAuthRejection } from '../../../../../lib/packetServer';
import { UUID } from '../../../../../lib/truckServer';
import { RATECON_ROLES } from '../../../../../lib/dispatch';
import { cookieToken } from '../../../../../lib/authCookie';
import { docInCompany } from '../../../../../lib/loadDocsServer';
import { visibleDocsFor } from '../../../../../lib/loadDocs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const NOT_FOUND = { error: 'Load not found.' };

// Storage paths are `{uploaderId}/{timestamp}-{name}`. Refuse a row whose path is not in the uploader's folder.
function isUploaderPath(doc) {
  const path = doc?.file_path;
  const uid = doc?.user_id;
  return !!path && !!uid && String(path).startsWith(`${uid}/`);
}

async function latestCompanyRateCon(svc, load, docs) {
  const ranked = (docs || []).slice().sort((a, b) => {
    const tb = Date.parse(b.created_at) || 0;
    const ta = Date.parse(a.created_at) || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
  for (const d of ranked) {
    if (!isUploaderPath(d)) continue;
    if (!(await docInCompany(svc, load.user_id, d))) continue;
    return d;
  }
  return null;
}

export async function GET(req, { params, deps } = {}) {
  const id = params?.id;
  if (!UUID.test(String(id || ''))) return json(NOT_FOUND, 404);
  const token = bearer(req) || cookieToken(req);
  if (!token) return json({ error: 'Sign in first.' }, 401);
  const svc = deps?.sb || serviceClient();
  if (!svc) return json({ error: 'Rate con access isn’t set up on this server.' }, 503);
  const uc = (deps?.mkUserClient || userClient)(token);

  const { data: load, error: lErr } = await svc.from('loads').select('id, user_id, assigned_driver_user_id, show_rate_to_driver').eq('id', id).maybeSingle();
  if (lErr) { console.error('[dispatch ratecon] load', lErr.message); return json({ error: 'Couldn’t open the rate con. Try again.' }, 500); }
  if (!load) return json(NOT_FOUND, 404);

  const { data: role, error: rErr } = await uc.rpc('packet_role', { p_owner: load.user_id });
  if (rErr) return isAuthRejection(rErr) || /PGRST30/.test(rErr.code || '') ? json({ error: 'Your sign-in expired. Please sign in again.', auth: true }, 401)
    : json({ error: 'Couldn’t check your access. Try again.', retry: true }, 503);
  if (!role) return json(NOT_FOUND, 404); // not on this company: don't confirm the load exists
  if (!RATECON_ROLES.has(role)) return json({ error: 'Drivers can’t open rate cons.' }, 403);

  const { data: docs, error: dErr } = await svc.from('documents').select('id, user_id, file_path, created_at, doc_type')
    .eq('load_id', load.id).eq('doc_type', 'rate_confirmation')
    .order('created_at', { ascending: false });
  if (dErr) { console.error('[dispatch ratecon] docs', dErr.message); return json({ error: 'Couldn’t open the rate con. Try again.' }, 500); }
  // visibleDocsFor is the load-page rule. For owner / management / dispatcher it does not hide rate cons;
  // it is applied here so this route cannot grow past that list.
  const visible = visibleDocsFor(role, load, null, docs || []);
  const doc = await latestCompanyRateCon(svc, load, visible);
  const path = doc?.file_path;
  if (!path) return json({ error: 'This load has no rate con.' }, 404);
  const { data, error } = await svc.storage.from('documents').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { console.error('[dispatch ratecon] sign', error?.message); return json({ error: 'Couldn’t open the rate con. Try again.' }, 500); }
  return json({ url: data.signedUrl });
}
