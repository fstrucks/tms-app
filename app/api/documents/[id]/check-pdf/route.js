// POST → { ok } | 422 { error }. Server check for a PDF the uploader just stored (scanner "Choose PDF", and every
// scan): the caller must be the uploader; the stored object must be a real PDF (starts with %PDF-) within the 10 MB
// PDF limit. A file that fails is removed (storage object + documents row) so it never shows or goes in a packet.
import { loadDocsCtx, json, UUID } from '../../../../lib/loadDocsServer';
import { pdfProblem, PDF_PROBLEM } from '../../../../lib/pdfFile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const { c, svc } = x;
  if (!UUID.test(params?.id || '')) return json({ error: 'Document not found.' }, 404);
  const { data: doc } = await svc.from('documents').select('id,user_id,file_path').eq('id', params.id).maybeSingle();
  if (!doc || doc.user_id !== c.user.id) return json({ error: 'Document not found.' }, 404);
  const { data: blob, error } = await svc.storage.from('documents').download(doc.file_path);
  if (error || !blob) return json({ error: 'Couldn’t read the uploaded file. Please try again.' }, 502);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const why = pdfProblem(bytes.length, bytes.subarray(0, 5));
  if (why) {
    await svc.storage.from('documents').remove([doc.file_path]);
    await svc.from('documents').delete().eq('id', doc.id).eq('user_id', c.user.id);
    return json({ error: PDF_PROBLEM[why], reason: why }, 422);
  }
  return json({ ok: true });
}
