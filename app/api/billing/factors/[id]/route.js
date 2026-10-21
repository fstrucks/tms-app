// PATCH → edit a factor, DELETE → remove it (owner / management). Loads / invoices keep their copy of the details.
import { billingCtx, json, isMissing, SETUP, readBody, UUID } from '../../../../lib/invoiceServer';
import { validateFactor, dbErrorText } from '../../../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Not found.' }, 404);
  const body = await readBody(req); if (!body) return json({ error: 'Bad request.' }, 400);
  const v = validateFactor(body); if (v.error) return json({ error: v.error }, 422);
  const { data, error } = await x.db.from('factors').update(v.row).eq('id', params.id).eq('owner_id', x.c.ownerId).select('*').maybeSingle();
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: dbErrorText({ ...error, message: `${error.message || ''} factor` }) }, error.code === '23505' ? 409 : 422);
  if (!data) return json({ error: 'Not found.' }, 404);
  return json({ ok: true, factor: data });
}

export async function DELETE(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Not found.' }, 404);
  const { data, error } = await x.db.from('factors').delete().eq('id', params.id).eq('owner_id', x.c.ownerId).select('id');
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t delete it. Please try again.' }, 500);
  if (!data?.length) return json({ error: 'Not found.' }, 404);
  return json({ ok: true });
}
