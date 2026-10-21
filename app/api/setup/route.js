import { buildChecklist, modelFromPayload, summarize } from '../../lib/setupProgress.js';
import { CHECKLIST_ITEMS } from '../../lib/setupCatalog.js';
import { isMissing } from '../../lib/vaultServer.js';
import {
  json, setupCtx, loadSetup, saveStatus, saveSetupProfile, touchSetup, saveReminder, BUCKET, UUID, isOffice,
} from '../../lib/setupServer.js';

const DOC_TYPES = new Set(CHECKLIST_ITEMS.map((i) => i.docType).filter(Boolean));

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

async function openFile(c, id) {
  if (!isOffice(c.role)) return json({ error: 'Only the office can open these files.' }, 403);
  if (!UUID.test(id || '') || !c.db) return json({ error: 'Document not found.' }, 404);
  const { data, error } = await c.db.from('documents').select('id,user_id,doc_type,file_path').eq('id', id).eq('user_id', c.ownerId).maybeSingle();
  if (error || !data) return json({ error: 'Document not found.' }, error && !isMissing(error) ? 500 : 404);
  if (!DOC_TYPES.has(data.doc_type)) return json({ error: 'Document not found.' }, 404);
  const signed = await c.db.storage.from(BUCKET).createSignedUrl(data.file_path, 120);
  if (signed.error || !signed.data?.signedUrl) return json({ error: 'Couldn’t open the file. Please try again.' }, 502);
  return json({ url: signed.data.signedUrl });
}

export async function GET(req) {
  const c = await setupCtx(req);
  if (c.res) return c.res;
  const view = new URL(req.url).searchParams.get('view');
  if (view) return openFile(c, view);
  const data = await loadSetup(c);
  if (data.error) return json({ error: data.error }, 500);
  return json(data);
}

export async function PATCH(req) {
  const c = await setupCtx(req);
  if (c.res) return c.res;
  if (!c.profile) return json({ error: 'Add a company profile first.', needsProfile: true }, 404);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (body?.action === 'dismiss') {
    const current = await loadSetup(c);
    if (current.error) return json({ error: current.error }, 500);
    if (!current.setupNeeded) {
      const sum = summarize(buildChecklist(modelFromPayload(current, current.today)));
      if (sum.requiredDone < sum.requiredTotal) {
        return json({ error: 'The home reminder stays up until every required item is done. You can leave and come back any time.' }, 422);
      }
    }
  }
  let result = { error: 'Bad request.', status: 400 };
  if (body?.action === 'status') result = await saveStatus(c, body);
  else if (body?.action === 'answers') result = await saveSetupProfile(c, body);
  else if (body?.action === 'start' || body?.action === 'prompt' || body?.action === 'dismiss') result = await touchSetup(c, body.action);
  else if (body?.action === 'reminder') result = await saveReminder(c, body);
  if (result.error) return json({ error: result.error, setupNeeded: result.status === 503 }, result.status || 400);
  const data = await loadSetup(c);
  if (data.error) return json({ error: data.error }, 500);
  return json(data);
}
