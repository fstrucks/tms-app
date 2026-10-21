// POST { action } on a finalized invoice (owner / management). Nothing is emailed from here.
//   mark_sent { sent_to, files?, note? } → status Sent (manual; v1 has no email sending)
//   paid { paid_amount?, paid_at? }      → Paid, or Short-paid when less than the total; the load moves to Paid
//   void { reason }                     → Void (the load can then get a new draft)
//   log { kind: 'download' | 'print', files? } → history only
import { billingCtx, json, readBody, UUID, isMissing, SETUP } from '../../../lib/invoiceServer';
import { statusChange } from '../../../lib/invoiceBundle';
import { dbErrorText } from '../../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps, { edit: true }); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Invoice not found.' }, 404);
  const body = await readBody(req); if (!body) return json({ error: 'Bad request.' }, 400);
  const { data: inv, error } = await x.db.from('invoices').select('*').eq('id', params.id).eq('owner_id', x.c.ownerId).maybeSingle();
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load the invoice.' }, 500);
  if (!inv) return json({ error: 'Invoice not found.' }, 404);
  const ch = statusChange(inv, body.action, body);
  if (ch.error) return json({ error: ch.error }, 422);
  let saved = inv;
  if (ch.patch) {
    const { data, error: uErr } = await x.db.from('invoices').update(ch.patch).eq('id', inv.id).eq('owner_id', x.c.ownerId).select('*').maybeSingle();
    if (uErr) return json({ error: dbErrorText(uErr) }, 422);
    if (!data) return json({ error: 'That didn’t save. Please try again.' }, 500);
    saved = data;
  }
  await x.db.from('invoice_events').insert({ invoice_id: inv.id, owner_id: x.c.ownerId, created_by: x.c.user.id, ...ch.event });
  if (ch.loadStatus && inv.load_id) {
    await x.svc.from('loads').update({ status: ch.loadStatus }).eq('id', inv.load_id).eq('user_id', x.c.ownerId).in('status', ['delivered', 'invoiced']);
  }
  return json({ ok: true, invoice: saved });
}
