// POST → add a broker (owner / management). Listing is part of GET /api/billing.
import { billingCtx, json, isMissing, SETUP, readBody } from '../../../lib/invoiceServer';
import { validateBroker, dbErrorText } from '../../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  const body = await readBody(req); if (!body) return json({ error: 'Bad request.' }, 400);
  const v = validateBroker(body); if (v.error) return json({ error: v.error }, 422);
  const { data, error } = await x.db.from('brokers').insert({ ...v.row, owner_id: x.c.ownerId }).select('*').single();
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: dbErrorText({ ...error, message: `${error.message || ''} broker` }) }, error.code === '23505' ? 409 : 422);
  return json({ ok: true, broker: data }, 201);
}
