// Company logo for invoices (optional). GET → { url } (office roles, 5-minute link). POST multipart "file" (PNG/JPG
// ≤ 1 MB) and DELETE: owner / management. Stored privately under {owner}/company/ in the documents bucket.
import { billingCtx, json, isMissing, SETUP, companyProfile } from '../../../lib/invoiceServer';
import { checkLogo } from '../../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const { profile, error } = await companyProfile(x.svc, x.c.ownerId);
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load the logo.' }, 500);
  if (!profile?.logo_path) return json({ url: null });
  const { data } = await x.svc.storage.from('documents').createSignedUrl(profile.logo_path, 300);
  return json({ url: data?.signedUrl || null });
}

export async function POST(req, { deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  let file; try { file = (await req.formData()).get('file'); } catch { file = null; }
  if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'Choose a PNG or JPG image.' }, 400);
  const chk = checkLogo({ type: file.type, size: file.size }); if (chk.error) return json({ error: chk.error }, 422);
  const { profile, error } = await companyProfile(x.svc, x.c.ownerId);
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load your company.' }, 500);
  if (!profile) return json({ error: 'Fill in your company profile first.' }, 409);
  const path = `${x.c.ownerId}/company/logo-${Date.now()}.${chk.ext}`;
  const up = await x.svc.storage.from('documents').upload(path, new Uint8Array(await file.arrayBuffer()), { contentType: chk.contentType, upsert: false });
  if (up.error) return json({ error: 'Couldn’t upload the logo. Please try again.' }, 500);
  const { error: uErr } = await x.svc.from('company_profiles').update({ logo_path: path }).eq('id', profile.id);
  if (uErr) { await x.svc.storage.from('documents').remove([path]); return isMissing(uErr) ? json(SETUP, 409) : json({ error: 'Couldn’t save the logo.' }, 500); }
  if (profile.logo_path && profile.logo_path !== path) await x.svc.storage.from('documents').remove([profile.logo_path]);
  return json({ ok: true, has_logo: true });
}

export async function DELETE(req, { deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  const { profile, error } = await companyProfile(x.svc, x.c.ownerId);
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load your company.' }, 500);
  if (!profile?.logo_path) return json({ ok: true, has_logo: false });
  const { error: uErr } = await x.svc.from('company_profiles').update({ logo_path: null }).eq('id', profile.id);
  if (uErr) return json({ error: 'Couldn’t remove the logo.' }, 500);
  await x.svc.storage.from('documents').remove([profile.logo_path]);
  return json({ ok: true, has_logo: false });
}
