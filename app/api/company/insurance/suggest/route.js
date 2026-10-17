import { insuranceCtx, canWriteInsurance, json, isMissing } from '../../../../lib/insuranceServer';
import { suggestionsToPolicies } from '../../../../lib/coiRequest';
import { runExtraction } from '../../../../lib/ai-extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Body: { documentId } of an uploaded COI / declarations document. The AI reader SUGGESTS policy rows;
// they're saved with confirmed = false and don't count for gap checks until the owner confirms each one.
export async function POST(req, { deps } = {}) {
  const c = await insuranceCtx(req, deps); if (c.res) return c.res;
  if (!canWriteInsurance(c.role)) return json({ error: 'Only the owner or management can add insurance info.' }, 403);
  const env = deps?.env || process.env;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return json({ error: 'The document reader isn’t set up. Enter the policies by hand.' }, 501);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!UUID.test(b.documentId || '')) return json({ error: 'Bad request.' }, 400);
  const { data: doc } = await c.sb.from('documents').select('id,file_path,original_filename,doc_type').eq('id', b.documentId).maybeSingle();
  if (!doc?.file_path) return json({ error: 'Document not found.' }, 404);
  const ext = String(doc.file_path.split('.').pop() || '').toLowerCase();
  const mime = TYPES[ext];
  if (!mime) return json({ error: 'The reader handles PDF, JPG, PNG or WEBP files.' }, 415);
  const { data: blob } = await c.sb.storage.from('documents').download(doc.file_path);
  if (!blob) return json({ error: 'Could not open the document.' }, 404);
  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.length > MAX_BYTES) return json({ error: 'That file is too large for the reader (10 MB max).' }, 413);
  const extract = deps?.runExtraction || runExtraction;
  const r = await extract('coi', { apiKey, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
  if (r.error) { console.error('[insurance] suggest', ...(r.error.log || [])); return json({ error: 'The reader couldn’t read that document. Enter the policies by hand.' }, 502); }
  const rows = suggestionsToPolicies(r.data, doc.id).map((p) => ({ ...p, owner_id: c.ownerId }));
  if (!rows.length) return json({ policies: [], note: 'No coverage lines found on that document.' });
  const ins = await c.sb.from('insurance_policies').insert(rows).select('*');
  if (ins.error) return isMissing(ins.error) ? json({ error: 'Insurance info needs a database update that hasn’t been applied yet.', setupNeeded: true }, 503) : json({ error: 'Could not save the suggestions.' }, 500);
  return json({ policies: ins.data || [] });
}
