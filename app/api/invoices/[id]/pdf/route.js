// GET → the invoice PDF (office roles). Built from the invoice's saved copy of the details + the company profile/logo.
import { billingCtx, json, isMissing, SETUP, UUID, companyProfile, loadLogo } from '../../../../lib/invoiceServer';
import { invoicePdf } from '../../../../lib/invoicePdf';
import { invoiceFileName } from '../../../../lib/invoice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Invoice not found.' }, 404);
  const { data: inv, error } = await x.db.from('invoices').select('*').eq('id', params.id).eq('owner_id', x.c.ownerId).maybeSingle();
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load the invoice.' }, 500);
  if (!inv) return json({ error: 'Invoice not found.' }, 404);
  const { profile } = await companyProfile(x.svc, x.c.ownerId);
  const bytes = await invoicePdf(inv, profile, { logo: await loadLogo(x.svc, profile?.logo_path) });
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="${invoiceFileName(inv, 'invoice')}"` } });
}
