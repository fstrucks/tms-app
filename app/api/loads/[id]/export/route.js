// Load export packet (Marc, Oct 25). Owner, management and dispatchers of the load's company; never drivers.
// Delivered / invoiced / paid loads only. Read-only: nothing is created, numbered, saved or emailed here.
//   GET              → { canExport, status, invoiceNumber, options: exportOptions(), fileNames }
//   GET ?download=1&invoice=1|0&docs=<id,id>&stopTimes=1&loadNotes=1&note=<text>&tz=
//                    → one PDF in packet order: invoice, rate con, other docs, scale tickets, POD, pictures, stop times, notes
import { billingCtx, json, invoiceContext } from '../../../../lib/invoiceServer';
import { canExportStatus, exportOptions, exportInvoice, packetFileName } from '../../../../lib/loadExport';
import { loadExportDocs, readSelection, buildLoadPacket } from '../../../../lib/loadExportServer';

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
  const docs = await loadExportDocs(x, load);
  const inv = exportInvoice(ctx);
  const sp = new URL(req.url).searchParams;

  if (sp.get('download') !== '1') {
    return json({ canExport: true, status: load.status, invoiceNumber: inv.invoice_number || null, invoiceStatus: inv.status,
      options: exportOptions({ load, docs }),
      fileNames: { withInvoice: packetFileName(load, true), withoutInvoice: packetFileName(load, false) } });
  }

  const sel = readSelection(Object.fromEntries(sp));
  const r = await buildLoadPacket(x, ctx, docs, sel, sp.get('tz') || '');
  if (r.error) return json({ error: r.error }, r.status);
  const { items, skipped } = r;
  return new Response(r.bytes, { status: 200, headers: {
    'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${r.filename}"`,
    'X-Packet-Items': String(items.length), 'X-Packet-Skipped': String(skipped.length),
    'X-Packet-Skipped-Names': encodeURIComponent(skipped.join(' | ')).slice(0, 1500),
  } });
}
