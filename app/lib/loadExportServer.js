// Builds the load export PDF on the server. Shared by the Download (GET /export) and the email Send
// (POST /send) so both produce the same file with the same name.
import { docInCompany } from './loadDocsServer';
import { exportOptions, planPacket, exportInvoice, packetFileName, NOTE_MAX } from './loadExport';
import { buildBundlePdf } from './invoiceBundlePdf';
import { invoicePdf } from './invoicePdf';
import { stopTimesPdf } from './stopTimesPdf';
import { delaysForLoad } from './stopTimesServer';
import { notesPdf } from './notesPdf';
import { loadLogo } from './invoiceServer';

// Company documents on the load (invoice-type docs excluded).
export async function loadExportDocs(x, load) {
  const { data: rows } = await x.svc.from('documents').select('id,user_id,load_id,doc_type,file_path,original_filename,created_at').eq('load_id', load.id);
  const docs = [];
  for (const d of rows || []) if (d.doc_type !== 'invoice' && await docInCompany(x.svc, x.c.ownerId, d)) docs.push(d);
  return docs;
}

// Raw selection (query params or a JSON body) → the shape planPacket() takes.
export function readSelection(s = {}) {
  const ids = Array.isArray(s.docIds) ? s.docIds : String(s.docs || '').split(',');
  const on = (v) => v === true || v === '1' || v === 1;
  return { invoice: on(s.invoice), docIds: ids.map(String).filter(Boolean), stopTimes: on(s.stopTimes), loadNotes: on(s.loadNotes), note: String(s.note || '').slice(0, NOTE_MAX) };
}

// → { bytes, items, skipped, filename, invoice } | { error, status }
export async function buildLoadPacket(x, ctx, docs, sel, tz = '') {
  const { load, profile } = ctx;
  const { items, unsupported } = planPacket({ load, docs, sel });
  if (!items.length) return { error: 'Nothing is selected. Pick at least one item to export.', status: 422 };
  const inv = exportInvoice(ctx);
  const download = async (path) => { const { data } = await x.svc.storage.from('documents').download(path); return data ? new Uint8Array(await data.arrayBuffer()) : null; };
  const invBytes = sel.invoice ? await invoicePdf(inv, profile, { logo: await loadLogo(x.svc, profile?.logo_path) }) : null;
  const list = [];
  for (const it of items) {
    if (it.kind === 'doc') list.push({ name: it.label, doc: it.doc, supported: true });
    else if (it.kind === 'stopTimes') list.push({ name: 'Stop times', pdfBytes: await stopTimesPdf(load, profile, { tz, delays: await delaysForLoad(x.svc, load.id) }).catch(() => null) });
    else if (it.kind === 'notes') list.push({ name: 'Notes', pdfBytes: await notesPdf({ loadNumber: load.broker_load_number, note: it.note, loadNotes: it.loadNotes }) });
  }
  const r = await buildBundlePdf(invBytes, list, download, { title: sel.invoice ? 'Load packet with invoice' : 'Load packet' });
  return { bytes: r.bytes, items, skipped: [...unsupported, ...r.skipped], filename: packetFileName(load, sel.invoice), invoice: inv };
}

// Kept for the info GET.
export { exportOptions };
