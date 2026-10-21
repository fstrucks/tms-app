// The paperwork that goes with an invoice (office roles; nothing is emailed).
//   GET                    → { files, checks, size, email: { to, subject, body }, format }
//   GET ?download=merged   → one PDF: invoice, rate con, BOL/POD, receipts, (NOA when factored)
//   GET ?download=<docId|invoice> → that one file as a PDF named {LOAD}_{Doc}.pdf (photos become a PDF page)
import { billingCtx, json, invoiceWithDocs, companyProfile, loadLogo } from '../../../../lib/invoiceServer';
import { bundleFiles, bundleChecks, sizeCheck, emailText, recipientFor } from '../../../../lib/invoiceBundle';
import { buildBundlePdf, docToPdf } from '../../../../lib/invoiceBundlePdf';
import { invoicePdf } from '../../../../lib/invoicePdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const pdfRes = (bytes, name) => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name}"` } });

async function sizes(svc, docs) {
  const out = {};
  await Promise.all(docs.map(async (d) => {
    const dir = d.file_path.split('/').slice(0, -1).join('/'), name = d.file_path.split('/').pop();
    try { const { data } = await svc.storage.from('documents').list(dir, { search: name, limit: 5 }); const f = (data || []).find((x) => x.name === name); out[d.id] = f?.metadata?.size ?? null; } catch { out[d.id] = null; }
  }));
  return out;
}

export async function GET(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const b = await invoiceWithDocs(x, params?.id); if (b.res) return b.res;
  const { invoice, docs } = b;
  const { profile } = await companyProfile(x.svc, x.c.ownerId);
  const dl = new URL(req.url).searchParams.get('download');
  if (dl) {
    const download = async (p) => { const { data } = await x.svc.storage.from('documents').download(p); return data ? new Uint8Array(await data.arrayBuffer()) : null; };
    const inv = await invoicePdf(invoice, profile, { logo: await loadLogo(x.svc, profile?.logo_path) });
    const files = bundleFiles(invoice, docs);
    if (dl === 'invoice') return pdfRes(inv, files[0].name);
    if (dl === 'merged') {
      const r = await buildBundlePdf(inv, files.slice(1).map((f) => ({ ...f, doc: docs.find((d) => d.id === f.docId) })), download);
      return pdfRes(r.bytes, files[0].name.replace(/_Invoice\.pdf$/, '_Packet.pdf'));
    }
    const f = files.find((y) => y.docId === dl);
    if (!f) return json({ error: 'File not found.' }, 404);
    const bytes = await docToPdf(docs.find((d) => d.id === dl), download);
    if (!bytes) return json({ error: 'Couldn’t read that file.' }, 422);
    return pdfRes(bytes, f.name);
  }
  const sz = await sizes(x.svc, docs);
  const files = bundleFiles(invoice, docs.map((d) => ({ ...d, size: sz[d.id] })));
  let factor = null;
  if (invoice.factor_id) { const { data } = await x.db.from('factors').select('*').eq('id', invoice.factor_id).eq('owner_id', x.c.ownerId).maybeSingle(); factor = data || null; }
  const t = emailText(invoice, profile, files);
  return json({ invoice, canEdit: x.canEdit, files, checks: bundleChecks(invoice, docs, { otherSent: b.otherSent }), size: sizeCheck(files),
    format: factor?.packet_format || 'merged', email: { to: recipientFor(invoice, factor), ...t } });
}
