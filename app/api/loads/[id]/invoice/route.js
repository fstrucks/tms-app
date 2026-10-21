// The load page's Invoice tab.
//   GET   → invoice for this load (makes the draft for a delivered load if none yet; owner / management) + brokers,
//           factoring companies and billing settings. Office roles only; drivers get 403.
//   PATCH { line_items?, notes?, terms_days?, broker_id?, factored? } → saves the draft (owner / management).
//           broker_id / factored are saved on the load too (the factoring switch is per load).
//   DELETE → deletes this load's unnumbered draft (owner / management). Opening the tab again starts a fresh draft
//           from the load while it's delivered; use Void to keep it cleared.
//   POST  { action: 'finalize' } → gives the next number (finalize_invoice) and moves the load to Invoiced.
import { billingCtx, json, readBody, invoiceContext, saveDraft, invoiceResponse, isMissing, SETUP, UUID, applyLoadStatus } from '../../../../lib/invoiceServer';
import { cleanLines, parseTerms, dbErrorText } from '../../../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const ctx = await invoiceContext(x, params?.id); if (ctx.res) return ctx.res;
  return json(invoiceResponse(x, ctx));
}

export async function PATCH(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  const body = await readBody(req); if (!body) return json({ error: 'Bad request.' }, 400);
  const ctx = await invoiceContext(x, params?.id, { autoDraft: false }); if (ctx.res) return ctx.res;
  const patch = {};
  if ('line_items' in body) { const l = cleanLines(body.line_items); if (l.error) return json({ error: l.error }, 422); patch.lines = l.lines; }
  if ('notes' in body) patch.notes = String(body.notes ?? '').trim().slice(0, 1000) || null;
  if ('terms_days' in body) { const t = parseTerms(body.terms_days); if (t.error) return json({ error: t.error }, 422); if (t.value != null) patch.terms_days = t.value; }
  // Load-level billing: which broker record, and the factoring switch.
  const loadPatch = {};
  if ('broker_id' in body) {
    const id = body.broker_id || null;
    if (id && (!UUID.test(id) || !ctx.brokers.some((b) => b.id === id))) return json({ error: 'Pick a broker from your list.' }, 422);
    loadPatch.broker_id = id;
  }
  if ('factored' in body) {
    if (body.factored !== null && typeof body.factored !== 'boolean') return json({ error: 'Bad request.' }, 400);
    if (body.factored === true && !ctx.profile?.default_factor_id) return json({ error: 'Set your factoring company first (Company → Billing).' }, 422);
    loadPatch.factored = body.factored;
  }
  if (ctx.invoice && ctx.invoice.status !== 'draft' && (patch.lines || Object.keys(loadPatch).length)) return json({ error: 'This invoice is finalized. Void it to make changes.' }, 409);
  if (Object.keys(loadPatch).length) {
    const { data, error } = await x.svc.from('loads').update(loadPatch).eq('id', ctx.load.id).eq('user_id', x.c.ownerId).select('id, broker_id, factored').maybeSingle();
    if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t save the load.' }, 500);
    if (!data) return json({ error: 'Load not found.' }, 404);
    ctx.load = { ...ctx.load, ...loadPatch };
  }
  const d = await saveDraft(x, ctx, patch); if (d.res) return d.res;
  ctx.invoice = d.invoice;
  return json({ ok: true, ...invoiceResponse(x, ctx) });
}

export async function POST(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  const body = await readBody(req); if (!body || body.action !== 'finalize') return json({ error: 'Bad request.' }, 400);
  const ctx = await invoiceContext(x, params?.id, { autoDraft: false }); if (ctx.res) return ctx.res;
  if (!ctx.invoice) return json({ error: 'There’s no invoice draft for this load yet.' }, 404);
  if (ctx.invoice.status !== 'draft') return json({ error: 'This invoice is already finalized.', invoice: ctx.invoice }, 409);
  if (!ctx.profile) return json({ error: 'Fill in your company profile first (Account menu → Company).' }, 409);
  // Refresh the copy of the broker / remit-to details right before the number is given.
  const d = await saveDraft(x, ctx, { keepTerms: true }); if (d.res) return d.res;
  const { data, error } = await x.db.rpc('finalize_invoice', { p_invoice: d.invoice.id });
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: dbErrorText(error, 'Couldn’t finalize the invoice. Please try again.') }, 422);
  const inv = Array.isArray(data) ? data[0] : data;
  if (!inv?.invoice_number) return json({ error: 'Couldn’t finalize the invoice. Please try again.' }, 500);
  ctx.invoice = inv;
  // finalize_invoice() only moves Delivered → Invoiced; a Booked / In transit load (QA #1) is moved here. The status
  // returned is the one read back from the database, so the message never claims a change that didn't happen.
  const before = ctx.load.status;
  const { data: now } = await x.svc.from('loads').select('status').eq('id', ctx.load.id).eq('user_id', x.c.ownerId).maybeSingle();
  const status = await applyLoadStatus(x.svc, x.c.ownerId, { ...ctx.load, status: now?.status ?? before }, 'finalize');
  ctx.load = { ...ctx.load, status };
  return json({ ok: true, loadStatusBefore: before, ...invoiceResponse(x, ctx) });
}

export async function DELETE(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  const ctx = await invoiceContext(x, params?.id, { autoDraft: false }); if (ctx.res) return ctx.res;
  if (!ctx.invoice) return json({ error: 'There’s no draft to delete.' }, 404);
  if (ctx.invoice.status !== 'draft' || ctx.invoice.invoice_number) return json({ error: 'Only drafts can be deleted. Void a finalized invoice instead.' }, 409);
  const { data, error } = await x.db.from('invoices').delete().eq('id', ctx.invoice.id).eq('owner_id', x.c.ownerId).eq('status', 'draft').select('id');
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t delete the draft. Please try again.' }, 500);
  if (!data?.length) return json({ error: 'That didn’t delete. Please try again.' }, 500);
  return json({ ok: true, deleted: true });
}
