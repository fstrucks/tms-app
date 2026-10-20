// GET → { documents: [{ id, doc_type, label, original_filename, created_at, url, isImage, source }], canLink }
// Documents linked to this load (documents.load_id) plus scale-ticket photos linked through scale_tickets.load_id
// (Truck tab scans). Who sees them: see canViewLoadDocs in lib/loadDocs.js. Signed URLs last 10 minutes.
import { loadDocsCtx, companyLoad, json, DOC_COLS } from '../../../../lib/loadDocsServer';
import { canViewLoadDocs, visibleDocsFor, isImagePath } from '../../../../lib/loadDocs';
import { docTypeLabel } from '../../../../lib/docTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const { c, svc } = x;
  const load = await companyLoad(svc, c.ownerId, params?.id);
  if (!load || !canViewLoadDocs(c.role, load, c.user.id)) return json({ error: 'Load not found.' }, 404);
  const direct = await svc.from('documents').select(DOC_COLS).eq('load_id', load.id).order('created_at', { ascending: false });
  if (direct.error) return json({ error: 'Couldn’t load this load’s documents.' }, 500);
  let viaTickets = [];
  const tk = await svc.from('scale_tickets').select('document_id').eq('user_id', c.ownerId).eq('load_id', load.id).not('document_id', 'is', null);
  const ids = [...new Set((tk.data || []).map((t) => t.document_id))].filter((id) => !(direct.data || []).some((d) => d.id === id));
  if (ids.length) viaTickets = ((await svc.from('documents').select(DOC_COLS).in('id', ids)).data || []).map((d) => ({ ...d, doc_type: d.doc_type || 'scale_ticket', _src: 'scale_ticket' }));
  const docs = visibleDocsFor(c.role, load, c.user.id, [...(direct.data || []), ...viaTickets]);
  const urls = docs.length ? (await svc.storage.from('documents').createSignedUrls(docs.map((d) => d.file_path), 600)).data || [] : [];
  const urlOf = new Map(urls.map((u) => [u.path, u.signedUrl]));
  return json({
    canLink: c.role !== 'driver' || load.assigned_driver_user_id === c.user.id,
    role: c.role,
    documents: docs.map((d) => ({ id: d.id, doc_type: d.doc_type, label: docTypeLabel(d.doc_type), original_filename: d.original_filename, created_at: d.created_at,
      file_path: d.user_id === c.user.id ? d.file_path : undefined, own: d.user_id === c.user.id,
      url: urlOf.get(d.file_path) || null, isImage: isImagePath(d.file_path), source: d._src || 'document' })),
  });
}
