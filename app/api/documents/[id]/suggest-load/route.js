// GET → { suggestion: { loadId, reason } | null, loads: [{ id, label }], read: { doc_kind, reference_numbers, doc_date } | null }
// Reads the document once with AI (numbers + date + kind; cached in ai_extracted_data) and suggests a load:
// matching load / reference number first, then the caller's active load, then the date. Never writes the link.
import { loadDocsCtx, companyDoc, pickableLoads, json } from '../../../../lib/loadDocsServer';
import { suggestLoad, loadForSuggest, loadPickLabel, canLinkDoc } from '../../../../lib/loadDocs';
import { runExtraction } from '../../../../lib/ai-extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const { c, svc } = x;
  const doc = await companyDoc(svc, c.ownerId, params?.id);
  if (!doc || !canLinkDoc(c.role, { doc, load: null, userId: c.user.id })) return json({ error: 'Document not found.' }, 404);
  let read = doc.ai_extracted_data?.reference_numbers ? doc.ai_extracted_data : null;
  const apiKey = (deps?.env || process.env).OPENAI_API_KEY;
  const mime = MIME[String(doc.file_path || '').split('.').pop().toLowerCase()];
  if (!read && apiKey && mime && !doc.ai_extracted_data) {
    // Same per-user rate limit as rate con extraction.
    const { data: runId } = await svc.rpc('claim_extraction_slot', { p_user: doc.user_id, p_document: doc.id });
    if (runId) {
      const { data: blob } = await svc.storage.from('documents').download(doc.file_path);
      if (blob && blob.size <= 10 * 1024 * 1024) {
        const buf = Buffer.from(await blob.arrayBuffer());
        const r = await (deps?.runExtraction || runExtraction)('load_doc', { apiKey, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
        if (r.data) { read = r.data; await svc.from('documents').update({ ai_extracted_data: read }).eq('id', doc.id); }
        else console.error('[suggest-load] read', ...(r.error?.log || []));
        await svc.from('extraction_runs').update({ status: r.data ? 'success' : 'error' }).eq('id', runId);
      } else await svc.from('extraction_runs').update({ status: 'rejected' }).eq('id', runId);
    }
  }
  const rows = (await pickableLoads(svc, c.ownerId, { role: c.role, userId: c.user.id })).map(loadForSuggest);
  const suggestion = suggestLoad(rows, { refs: read?.reference_numbers || [], date: read?.doc_date || null, userId: c.user.id });
  return json({ suggestion, read, loads: rows.map((l) => ({ id: l.id, label: loadPickLabel(l) })) });
}
