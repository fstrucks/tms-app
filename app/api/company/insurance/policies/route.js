import { insuranceCtx, canWriteInsurance, json, isMissing } from '../../../../lib/insuranceServer';
import { validatePolicy } from '../../../../lib/coiRequest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard(req, deps) {
  const c = await insuranceCtx(req, deps); if (c.res) return c;
  if (!canWriteInsurance(c.role)) return { res: json({ error: 'Only the owner or management can edit insurance info.' }, 403) };
  let b; try { b = await req.json(); } catch { return { res: json({ error: 'Bad request.' }, 400) }; }
  return { ...c, b };
}
const fail = (e, msg) => (isMissing(e) ? json({ error: 'Insurance info needs a database update that hasn’t been applied yet.', setupNeeded: true }, 503) : json({ error: msg }, 500));

// Manual entry by owner/management counts as confirmed (they typed it in).
export async function POST(req, { deps } = {}) {
  const c = await guard(req, deps); if (c.res) return c.res;
  const { row, errors } = validatePolicy(c.b);
  if (Object.keys(errors).length) return json({ error: 'Please fix the highlighted fields.', errors }, 422);
  const now = new Date().toISOString();
  const r = await c.sb.from('insurance_policies').insert({ ...row, owner_id: c.ownerId, source: 'manual', confirmed: true, confirmed_by: c.user.id, confirmed_at: now }).select('*').maybeSingle();
  if (r.error) return fail(r.error, 'Could not save the policy.');
  return json({ policy: r.data });
}

// Body: { id, ...fields?, confirm?: true }. Editing an AI row keeps it unconfirmed unless confirm: true.
export async function PATCH(req, { deps } = {}) {
  const c = await guard(req, deps); if (c.res) return c.res;
  if (!UUID.test(c.b.id || '')) return json({ error: 'Bad request.' }, 400);
  const cur = await c.sb.from('insurance_policies').select('*').eq('id', c.b.id).eq('owner_id', c.ownerId).maybeSingle();
  if (cur.error) return fail(cur.error, 'Could not load the policy.');
  if (!cur.data) return json({ error: 'Policy not found.' }, 404);
  const { row, errors } = validatePolicy({ ...cur.data, ...c.b });
  if (Object.keys(errors).length) return json({ error: 'Please fix the highlighted fields.', errors }, 422);
  const now = new Date().toISOString();
  const patch = { ...row, updated_at: now, ...(c.b.confirm === true ? { confirmed: true, confirmed_by: c.user.id, confirmed_at: now } : {}) };
  const r = await c.sb.from('insurance_policies').update(patch).eq('id', c.b.id).eq('owner_id', c.ownerId).select('*').maybeSingle();
  if (r.error) return fail(r.error, 'Could not save the policy.');
  return json({ policy: r.data });
}

export async function DELETE(req, { deps } = {}) {
  const c = await guard(req, deps); if (c.res) return c.res;
  if (!UUID.test(c.b.id || '')) return json({ error: 'Bad request.' }, 400);
  const r = await c.sb.from('insurance_policies').delete().eq('id', c.b.id).eq('owner_id', c.ownerId);
  if (r.error) return fail(r.error, 'Could not remove the policy.');
  return json({ ok: true });
}
