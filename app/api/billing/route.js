// GET → { role, canEdit, settings, brokers, factors } (office roles). PATCH { default_terms_days, default_factor_id, remit_to }
// (owner / management). Fake data only in tests.
import { billingCtx, json, isMissing, SETUP, readBody, companyProfile } from '../../lib/invoiceServer';
import { publicBilling, validateBillingSettings, dbErrorText } from '../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const { c, svc, db, canEdit } = x;
  const [{ profile, error: pErr }, b, f] = await Promise.all([
    companyProfile(svc, c.ownerId),
    db.from('brokers').select('*').eq('owner_id', c.ownerId).order('name'),
    db.from('factors').select('*').eq('owner_id', c.ownerId).order('name'),
  ]);
  if (isMissing(pErr) || isMissing(b.error) || isMissing(f.error)) return json(SETUP, 409);
  if (pErr || b.error || f.error) return json({ error: 'Couldn’t load billing settings.' }, 500);
  return json({ role: c.role, canEdit, settings: publicBilling(profile), hasProfile: !!profile, brokers: b.data || [], factors: f.data || [] });
}

export async function PATCH(req, { deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  const { c, svc, db } = x;
  const body = await readBody(req); if (!body) return json({ error: 'Bad request.' }, 400);
  const { data: fs, error: fErr } = await db.from('factors').select('id').eq('owner_id', c.ownerId);
  if (fErr) return isMissing(fErr) ? json(SETUP, 409) : json({ error: 'Couldn’t load billing settings.' }, 500);
  const v = validateBillingSettings(body, (fs || []).map((r) => r.id));
  if (v.error) return json({ error: v.error }, 422);
  const { profile } = await companyProfile(svc, c.ownerId);
  if (!profile) return json({ error: 'Fill in your company profile first.' }, 409);
  const { data, error } = await db.from('company_profiles').update(v.patch).eq('id', profile.id).select('*').maybeSingle();
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: dbErrorText(error) }, 422);
  if (!data) return json({ error: 'That didn’t save. Please try again.' }, 500);
  return json({ ok: true, settings: publicBilling(data) });
}
