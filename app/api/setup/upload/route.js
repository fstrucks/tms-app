import { checkVaultUpload, MAX_VAULT_FILE_BYTES, fmtMB } from '../../../lib/companyDocs.js';
import { fileSizes, isMissing } from '../../../lib/vaultServer.js';
import { itemByKey } from '../../../lib/setupCatalog.js';
import { json, setupCtx, loadSetup, checklistPath, isChecklistPath, BUCKET, UUID } from '../../../lib/setupServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const idOr = (v) => (UUID.test(v || '') ? v : null);

export async function POST(req) {
  const c = await setupCtx(req);
  if (c.res) return c.res;
  if (!c.profile) return json({ error: 'Add a company profile first.', needsProfile: true }, 404);
  if (!c.office) return json({ error: 'Only the office can upload checklist documents.' }, 403);
  if (!c.db) return json({ error: 'Uploads for teammates aren’t available right now.' }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const item = itemByKey(b?.itemKey);
  if (!item?.docType || !item.kinds?.includes('upload')) return json({ error: 'That item doesn’t take a file.' }, 422);
  const truckId = idOr(b.truckId);
  const trailerId = idOr(b.trailerId);
  const driverId = idOr(b.driverId);
  const scopeId = driverId || trailerId || truckId || 'company';
  if (b.action === 'start') {
    const bad = checkVaultUpload({ size: b.size, contentType: b.contentType });
    if (bad) return json({ error: bad }, 422);
    const path = checklistPath(c.ownerId, item.docType, scopeId, b.filename);
    const { data, error } = await c.db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) return json({ error: 'Couldn’t start the upload. Please try again.' }, 502);
    return json({ path, token: data.token });
  }
  if (b.action === 'finish') {
    if (!isChecklistPath(c.ownerId, item.docType, b.path) || !String(b.path).includes(`/${scopeId}/`)) return json({ error: 'Bad upload path.' }, 400);
    const size = (await fileSizes(c.db, [b.path]))[b.path];
    if (size == null) return json({ error: 'The upload didn’t arrive. Please try again.' }, 409);
    if (size > MAX_VAULT_FILE_BYTES) {
      await c.db.storage.from(BUCKET).remove([b.path]);
      return json({ error: `That file is ${fmtMB(size)}. The limit is 7.5 MB.` }, 422);
    }
    const name = String(b.filename || '').trim().slice(0, 200) || b.path.split('/').pop();
    const ins = await c.db.from('documents').insert({
      user_id: c.ownerId, doc_type: item.docType, file_path: b.path, original_filename: name,
      load_id: null, truck_id: item.scope === 'company' ? null : truckId,
    }).select('id').single();
    if (ins.error) {
      await c.db.storage.from(BUCKET).remove([b.path]);
      return json({ error: 'Couldn’t save the document. Please try again.' }, isMissing(ins.error) ? 503 : 500);
    }
    const data = await loadSetup(c);
    if (data.error) return json({ error: data.error }, 500);
    return json({ ...data, saved: ins.data?.id || null });
  }
  return json({ error: 'Bad request.' }, 400);
}
