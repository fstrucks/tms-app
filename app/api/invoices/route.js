// GET → the company's invoices, newest first (office roles), with counts per tab and the unpaid total (QA #6).
// Unpaid = ready + sent + short-paid; for short-paid the balance (total - paid) counts. Tabs filter on the client.
import { billingCtx, json, isMissing, SETUP } from '../../lib/invoiceServer';
import { invoiceCounts } from '../../lib/invoiceBundle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const { data, error } = await x.db.from('invoices').select('id,load_id,status,invoice_number,invoice_date,due_date,total,paid_amount,bill_to,factored,load_ref,sent_at,sent_to,created_at')
    .eq('owner_id', x.c.ownerId).order('created_at', { ascending: false }).limit(1000);
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load invoices.' }, 500);
  const invoices = data || [];
  return json({ canEdit: x.canEdit, invoices, ...invoiceCounts(invoices) });
}
