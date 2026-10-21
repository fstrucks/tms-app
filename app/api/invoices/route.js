// GET → the company's invoices, newest first (office roles). ?status=draft|ready|sent|paid|short_paid|void|open
import { billingCtx, json, isMissing, SETUP } from '../../lib/invoiceServer';
import { INVOICE_STATUSES } from '../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const st = new URL(req.url).searchParams.get('status');
  let q = x.db.from('invoices').select('id,load_id,status,invoice_number,invoice_date,due_date,total,paid_amount,bill_to,factored,load_ref,sent_at,sent_to,created_at').eq('owner_id', x.c.ownerId);
  if (st === 'open') q = q.in('status', ['ready', 'sent']);
  else if (st && INVOICE_STATUSES[st]) q = q.eq('status', st);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load invoices.' }, 500);
  return json({ canEdit: x.canEdit, invoices: data || [] });
}
