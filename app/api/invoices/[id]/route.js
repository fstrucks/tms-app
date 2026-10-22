// POST { action } on a finalized invoice (owner / management). Nothing is emailed from here.
//   mark_sent { sent_to, files?, note? } → status Sent (manual; v1 has no email sending)
//   paid { paid_amount?, paid_at? }      → Paid (load → Paid), or Short-paid when less than the total (load stays open
//                                         as Invoiced). On a short-paid invoice it adds to the amount received.
//   write_off { note? }                → short-paid only: balance written off, invoice Paid, load → Paid
//   void { reason }                     → Void; an Invoiced / Paid load with no other non-void invoice goes back to Delivered
//                                         (the auto-draft trigger skips loads with a void invoice: 20261021190000)
//   log { kind: 'download' | 'print', files? } → history only
import { billingCtx, json, readBody, UUID, isMissing, SETUP, applyLoadStatus } from '../../../lib/invoiceServer';
import { statusChange } from '../../../lib/invoiceBundle';
import { dbErrorText, loadStatusAfterVoid } from '../../../lib/invoice';

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
  // QA #1: the old filter only moved Delivered / Invoiced loads, so a Booked load never changed. Same rule as finalize;
  // the status is read back so the UI only reports a change that happened.
  let loadStatusBefore = null, loadStatus = null;
  if (ch.loadStatus && inv.load_id) {
    const { data: l } = await x.svc.from('loads').select('id,status').eq('id', inv.load_id).eq('user_id', x.c.ownerId).maybeSingle();
    loadStatusBefore = l?.status ?? null;
    loadStatus = l ? await applyLoadStatus(x.svc, x.c.ownerId, l, ch.loadStatus) : null;
  }
  if (saved.status === 'void' && inv.status !== 'void' && inv.load_id) {
    const { data: l } = await x.svc.from('loads').select('id,status').eq('id', inv.load_id).eq('user_id', x.c.ownerId).maybeSingle();
    if (l) {
      loadStatusBefore = l.status;
      const { data: rows } = await x.svc.from('invoices').select('id,status').eq('owner_id', x.c.ownerId).eq('load_id', inv.load_id);
      const next = loadStatusAfterVoid(l.status, (rows || []).filter((r) => r.id !== inv.id));
      if (next) {
        const { error: lErr } = await x.svc.from('loads').update({ status: next }).eq('id', l.id).eq('user_id', x.c.ownerId).eq('status', l.status);
        if (lErr) console.error('[invoices] void load status', lErr.code);
      }
      const { data: back } = await x.svc.from('loads').select('status').eq('id', l.id).eq('user_id', x.c.ownerId).maybeSingle();
      loadStatus = back?.status ?? l.status;
    }
  }
  return json({ ok: true, invoice: saved, loadStatusBefore, loadStatus });
}
