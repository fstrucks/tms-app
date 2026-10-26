// Load export packet (Marc, Oct 25). Owner, management and dispatchers of the load's company; never drivers.
// Delivered / invoiced / paid loads only. Read-only: nothing is created, numbered, saved or emailed here.
//   GET              → { canExport, status, invoiceNumber, options: exportOptions(), fileNames }
//   GET ?download=1&invoice=1|0&docs=<id,id>&stopTimes=1&loadNotes=1&note=<text>&tz=
//                    → one PDF in packet order: invoice, rate con, other docs, scale tickets, POD, pictures, stop times, notes
import { billingCtx, json, invoiceContext, loadLogo } from '../../../../lib/invoiceServer';
import { docInCompany } from '../../../../lib/loadDocsServer';
import { canExportStatus, exportOptions, planPacket, exportInvoice, packetFileName } from '../../../../lib/loadExport';
import { buildBundlePdf } from '../../../../lib/invoiceBundlePdf';
import { invoicePdf } from '../../../../lib/invoicePdf';
import { stopTimesPdf } from '../../../../lib/stopTimesPdf';
import { delaysForLoad } from '../../../../lib/stopTimesServer';
import { notesPdf } from '../../../../lib/notesPdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NOT_YET = { error: 'The export is available once the load is delivered.' };

export async function GET(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const ctx = await invoiceContext(x, params?.id, { autoDraft: false }); // never creates a draft from a GET
  if (ctx.res) return ctx.res;
  const { load, profile } = ctx;
  if (!canExportStatus(load.status)) return json(NOT_YET, 409);
  const { data: rows } = await x.svc.from('documents').select('id,user_id,load_id,doc_type,file_path,original_filename,created_at').eq('load_id', load.id);
  const docs = [];
  for (const d of rows || []) if (d.doc_type !== 'invoice' && await docInCompany(x.svc, x.c.ownerId, d)) docs.push(d);
  const inv = exportInvoice(ctx);
  const sp = new URL(req.url).searchParams;

  if (sp.get('download') !== '1') {
    return json({ canExport: true, status: load.status, invoiceNumber: inv.invoice_number || null, invoiceStatus: inv.status,
      options: exportOptions({ load, docs }),
      fileNames: { withInvoice: packetFileName(load, true), withoutInvoice: packetFileName(load, false) } });
  }

  const sel = { invoice: sp.get('invoice') === '1', docIds: (sp.get('docs') || '').split(',').filter(Boolean),
    stopTimes: sp.get('stopTimes') === '1', loadNotes: sp.get('loadNotes') === '1', note: sp.get('note') || '' };
  const { items, unsupported } = planPacket({ load, docs, sel });
  if (!items.length) return json({ error: 'Nothing is selected. Pick at least one item to export.' }, 422);
  const download = async (path) => { const { data } = await x.svc.storage.from('documents').download(path); return data ? new Uint8Array(await data.arrayBuffer()) : null; };
  const invBytes = sel.invoice ? await invoicePdf(inv, profile, { logo: await loadLogo(x.svc, profile?.logo_path) }) : null;
  const list = [];
  for (const it of items) {
    if (it.kind === 'doc') list.push({ name: it.label, doc: it.doc, supported: true });
    else if (it.kind === 'stopTimes') list.push({ name: 'Stop times', pdfBytes: await stopTimesPdf(load, profile, { tz: sp.get('tz'), delays: await delaysForLoad(x.svc, load.id) }).catch(() => null) });
    else if (it.kind === 'notes') list.push({ name: 'Notes', pdfBytes: await notesPdf({ loadNumber: load.broker_load_number, note: it.note, loadNotes: it.loadNotes }) });
  }
  const r = await buildBundlePdf(invBytes, list, download, { title: sel.invoice ? 'Load packet with invoice' : 'Load packet' });
  const skipped = [...unsupported, ...r.skipped];
  return new Response(r.bytes, { status: 200, headers: {
    'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${packetFileName(load, sel.invoice)}"`,
    'X-Packet-Items': String(items.length), 'X-Packet-Skipped': String(skipped.length),
    'X-Packet-Skipped-Names': encodeURIComponent(skipped.join(' | ')).slice(0, 1500),
  } });
}
