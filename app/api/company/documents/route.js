import { vaultCtx, vaultPayload, signedViewUrl, ownedVaultDoc, fileSizes, json, isMissing, BUCKET } from '../../../lib/vaultServer';
import { isVaultType, checkVaultUpload, vaultPath, isVaultPathFor, MAX_VAULT_FILE_BYTES, fmtMB } from '../../../lib/companyDocs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const WRITE_MSG = 'Only the owner or management can change company documents.';

const payload = async (c, extra = {}, deps) => {
  const p = await vaultPayload(c, deps?.today ? { today: deps.today } : {});
  if (p.error) return json({ error: 'Could not load company documents.' }, 500);
  return json({ ...p, ...extra });
};

// GET: the four vault rows, shaped for the caller's role (pick 2C: W-9 / NOA are status-only for dispatchers and
// drivers). GET ?view=<id>: a short-lived file URL, owner/management only (all four vault types).
export async function GET(req, { deps } = {}) {
  const c = await vaultCtx(req, deps); if (c.res) return c.res;
  const view = new URL(req.url).searchParams.get('view');
  if (view) {
    const r = await signedViewUrl(c, view);
    return r.url ? json({ url: r.url }) : json({ error: r.error }, r.status);
  }
  return payload(c, {}, deps);
}

// POST { action: 'start', docType, filename, size, contentType } → { path, token } for a direct upload to Storage
//   (files go straight to Storage, so the 7.5 MB cap isn't limited by the server's request size).
// POST { action: 'finish', docType, path, filename } → saves the documents row (under the OWNER) once the file is there.
export async function POST(req, { deps } = {}) {
  const c = await vaultCtx(req, deps); if (c.res) return c.res;
  if (!c.canManage) return json({ error: WRITE_MSG }, 403);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!isVaultType(b?.docType)) return json({ error: 'Pick a company document type.' }, 422);
  if (b.action === 'start') {
    const bad = checkVaultUpload({ size: b.size, contentType: b.contentType });
    if (bad) return json({ error: bad }, 422);
    const path = vaultPath(c.ownerId, b.docType, b.filename, deps?.now?.() ?? Date.now());
    const { data, error } = await c.db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) { console.error('[vault] upload url', error?.message); return json({ error: 'Couldn’t start the upload. Please try again.' }, 502); }
    return json({ path, token: data.token });
  }
  if (b.action === 'finish') {
    if (!isVaultPathFor(c.ownerId, b.docType, b.path)) return json({ error: 'Bad request (upload path).' }, 400);
    const size = (await fileSizes(c.db, [b.path]))[b.path];
    if (size == null) return json({ error: 'The upload didn’t arrive. Please try again.' }, 409);
    if (size > MAX_VAULT_FILE_BYTES) {
      await c.db.storage.from(BUCKET).remove([b.path]);
      return json({ error: `That file is ${fmtMB(size)}. The limit is 7.5 MB.` }, 422);
    }
    const name = String(b.filename || '').trim().slice(0, 200) || b.path.split('/').pop();
    const ins = await c.db.from('documents').insert({ user_id: c.ownerId, doc_type: b.docType, file_path: b.path, original_filename: name, load_id: null, truck_id: null }).select('id').single();
    if (ins.error) {
      console.error('[vault] insert', ins.error.code);
      await c.db.storage.from(BUCKET).remove([b.path]);
      return json({ error: 'Couldn’t save the document. Please try again.' }, isMissing(ins.error) ? 503 : 500);
    }
    return payload(c, { saved: ins.data?.id || null }, deps);
  }
  return json({ error: 'Bad request.' }, 400);
}

// DELETE ?id=<documents.id>: removes that version (row, then file). Newest-wins (pick 1A) makes the previous version
// current again with no extra step.
export async function DELETE(req, { deps } = {}) {
  const c = await vaultCtx(req, deps); if (c.res) return c.res;
  if (!c.canManage) return json({ error: WRITE_MSG }, 403);
  const id = new URL(req.url).searchParams.get('id');
  const doc = await ownedVaultDoc(c.db, c.ownerId, id);
  if (!doc) return json({ error: 'Document not found.' }, 404);
  const del = await c.db.from('documents').delete().eq('id', doc.id).eq('user_id', c.ownerId).select('id');
  if (del.error || !del.data?.length) { console.error('[vault] delete', del.error?.code); return json({ error: 'Couldn’t delete the document. Please try again.' }, 500); }
  let warning = null;
  if (doc.file_path) {
    const { error } = await c.db.storage.from(BUCKET).remove([doc.file_path]);
    if (error) warning = 'The document was removed, but its file couldn’t be deleted from storage.';
  }
  return payload(c, { deleted: doc.id, ...(warning ? { warning } : {}) }, deps);
}
