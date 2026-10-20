// PATCH { loadId | null } → link a document to one of the company's loads (or unlink). Rules: canLinkDoc in lib/loadDocs.js.
import { loadDocsCtx, companyLoad, companyDoc, json } from '../../../../lib/loadDocsServer';
import { canLinkDoc } from '../../../../lib/loadDocs';
import { isCompanyDocType } from '../../../../lib/docTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const { c, svc } = x;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const doc = await companyDoc(svc, c.ownerId, params?.id);
  if (!doc) return json({ error: 'Document not found.' }, 404);
  if (isCompanyDocType(doc.doc_type) || doc.doc_type === 'receipt') return json({ error: 'This document type isn’t linked to loads.' }, 422);
  const load = b?.loadId ? await companyLoad(svc, c.ownerId, b.loadId) : null;
  if (b?.loadId && !load) return json({ error: 'Load not found.' }, 404);
  const current = doc.load_id ? await companyLoad(svc, c.ownerId, doc.load_id) : null;
  if (!canLinkDoc(c.role, { doc, load, userId: c.user.id }) || (current && !canLinkDoc(c.role, { doc, load: current, userId: c.user.id }))) {
    return json({ error: 'You can only link your own documents to loads assigned to you.' }, 403);
  }
  const up = await svc.from('documents').update({ load_id: load?.id || null }).eq('id', doc.id).select('id,load_id').maybeSingle();
  if (up.error || !up.data) return json({ error: 'Couldn’t link the document.' }, 500);
  return json({ ok: true, document: up.data });
}
