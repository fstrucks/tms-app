// GET → { documents: [{ id, doc_type, label, original_filename, created_at, url, isImage, own, file_path?, load_id, load_label, uploader }], role }
// Documents tab "Team" view: every load document the caller may see under the PR #110 rules, across the company's
// loads. Same rules as the load page (/api/loads/:id/documents): it reuses canViewLoadDocs / visibleDocsFor per load,
// so nothing is widened. Owner / management / dispatcher: all company loads; drivers: only loads assigned to them,
// and no rate cons unless "Show rate to driver" is on for that load. Only documents linked to a company load (via
// documents.load_id or a Truck-tab scale ticket) are listed; unlinked uploads stay private to their uploader.
// file_path is returned only for the caller's own uploads (delete stays uploader-only via RLS). URLs last 10 minutes.
import { loadDocsCtx, json, DOC_COLS, docInCompany } from '../../../lib/loadDocsServer';
import { canViewLoadDocs, visibleDocsFor, isImagePath, loadPickLabel } from '../../../lib/loadDocs';
import { docTypeLabel, isDocumentsTabDoc } from '../../../lib/docTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOAD_COLS = 'id,user_id,broker_load_number,broker_name,status,assigned_driver_user_id,show_rate_to_driver,created_at';
const MAX_LOADS = 300;

async function uploaderNames(svc, ids, me) {
  const out = new Map();
  for (const id of ids) {
    if (id === me) { out.set(id, 'You'); continue; }
    let name = null;
    try {
      const { data } = await svc.auth.admin.getUserById(id);
      const u = data?.user;
      name = String(u?.user_metadata?.full_name || u?.user_metadata?.name || '').trim() || (u?.email ? String(u.email).split('@')[0] : null);
    } catch { /* name is optional */ }
    out.set(id, name || 'Teammate');
  }
  return out;
}

export async function GET(req, { deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const { c, svc } = x;
  const me = c.user.id;
  let lq = svc.from('loads').select(LOAD_COLS).eq('user_id', c.ownerId).order('created_at', { ascending: false }).limit(MAX_LOADS);
  if (!(c.role === 'owner' || c.role === 'management' || c.role === 'dispatcher')) lq = lq.eq('assigned_driver_user_id', me);
  const { data: rawLoads, error: lErr } = await lq;
  if (lErr) return json({ error: 'Couldn’t load team documents.' }, 500);
  const loads = (rawLoads || []).filter((l) => l.user_id === c.ownerId && canViewLoadDocs(c.role, l, me));
  if (!loads.length) return json({ documents: [], role: c.role });
  const loadIds = loads.map((l) => l.id);
  const direct = await svc.from('documents').select(DOC_COLS).in('load_id', loadIds).order('created_at', { ascending: false });
  if (direct.error) return json({ error: 'Couldn’t load team documents.' }, 500);
  const tk = await svc.from('scale_tickets').select('document_id, load_id').eq('user_id', c.ownerId).in('load_id', loadIds).not('document_id', 'is', null);
  const haveIds = new Set((direct.data || []).map((d) => d.id));
  const tkLoad = new Map((tk.data || []).filter((t) => t.document_id && !haveIds.has(t.document_id)).map((t) => [t.document_id, t.load_id]));
  let viaTickets = [];
  if (tkLoad.size) viaTickets = ((await svc.from('documents').select(DOC_COLS).in('id', [...tkLoad.keys()])).data || [])
    .map((d) => ({ ...d, doc_type: d.doc_type || 'scale_ticket', load_id: tkLoad.get(d.id) }));
  const byLoad = new Map(loads.map((l) => [l.id, l]));
  const all = [...(direct.data || []), ...viaTickets].filter((d) => d.doc_type !== 'receipt' && isDocumentsTabDoc(d));
  // Per-load rule check (same as the load page), then make sure each uploader belongs to this company.
  const visible = [];
  const inCo = new Map();
  for (const d of all) {
    const load = byLoad.get(d.load_id);
    if (!load || !visibleDocsFor(c.role, load, me, [d]).length) continue;
    if (!inCo.has(d.user_id)) inCo.set(d.user_id, await docInCompany(svc, c.ownerId, d));
    if (inCo.get(d.user_id)) visible.push(d);
  }
  visible.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const names = await uploaderNames(svc, [...new Set(visible.map((d) => d.user_id))], me);
  const urls = visible.length ? (await svc.storage.from('documents').createSignedUrls(visible.map((d) => d.file_path), 600)).data || [] : [];
  const urlOf = new Map(urls.map((u) => [u.path, u.signedUrl]));
  return json({
    role: c.role,
    documents: visible.map((d) => {
      const own = d.user_id === me;
      const load = byLoad.get(d.load_id);
      return { id: d.id, doc_type: d.doc_type, label: docTypeLabel(d.doc_type), original_filename: d.original_filename, created_at: d.created_at,
        own, file_path: own ? d.file_path : undefined, load_id: d.load_id, load_label: loadPickLabel(load), uploader: names.get(d.user_id) || 'Teammate',
        url: urlOf.get(d.file_path) || null, isImage: isImagePath(d.file_path) };
    }),
  });
}
