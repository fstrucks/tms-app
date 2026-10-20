// GET → scale tickets linked to this load, with net cargo and the same weight warnings as /truck.
// Read-only endpoint (any company role may view; drivers are read-only everywhere). Scoping: app/lib/truckServer.js.
// PR #110 (QA a): also `ticketDocs`, scale-ticket DOCUMENTS linked to the load (uploaded or scanned on Documents /
// the load page) that have no Truck-tab ticket row yet. Same visibility rule as the load's Documents section.
import { truckCtx, loadTicketsForLoad, json } from '../../../../lib/truckServer';
import { serviceClient } from '../../../../lib/packetServer';
import { companyLoad } from '../../../../lib/loadDocsServer';
import { canViewLoadDocs, isImagePath } from '../../../../lib/loadDocs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function ticketDocsFor(svc, c, loadId, tickets) {
  if (!svc) return [];
  const load = await companyLoad(svc, c.ownerId, loadId);
  if (!load || !canViewLoadDocs(c.role, load, c.user.id)) return [];
  const used = new Set((tickets || []).map((t) => t.document_id).filter(Boolean));
  const { data } = await svc.from('documents').select('id,file_path,original_filename,created_at,ai_extracted_data').eq('load_id', load.id).eq('doc_type', 'scale_ticket').order('created_at', { ascending: false });
  const docs = (data || []).filter((d) => !used.has(d.id));
  if (!docs.length) return [];
  const urls = (await svc.storage.from('documents').createSignedUrls(docs.map((d) => d.file_path), 600)).data || [];
  const urlOf = new Map(urls.map((u) => [u.path, u.signedUrl]));
  return docs.map((d) => ({ id: d.id, original_filename: d.original_filename, created_at: d.created_at, doc_date: d.ai_extracted_data?.doc_date || null,
    url: urlOf.get(d.file_path) || null, isImage: isImagePath(d.file_path) }));
}

export async function GET(req, { params, deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  const r = await loadTicketsForLoad(c.db, c.ownerId, params?.id);
  if (r.notFound) return json({ error: 'Load not found.' }, 404);
  const svc = deps?.sb || serviceClient();
  const ticketDocs = await ticketDocsFor(svc, c, params?.id, r.tickets).catch((e) => { console.error('[load tickets] docs', e?.message || e); return []; });
  if (r.setupNeeded) return json({ tickets: [], ticketDocs, setupNeeded: !ticketDocs.length, canEdit: c.canEdit });
  if (r.error) return json({ error: r.error }, 500);
  return json({ tickets: r.tickets, ticketDocs, loadWeight: r.load.weight ?? null, canEdit: c.canEdit });
}
