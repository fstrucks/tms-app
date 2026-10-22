// POST { reason? } → { ok }. Any signed-in user can report a facility note (once per note; repeats are OK).
// Same pattern as review reports: stored for moderation, the note stays up until then.
import { loadDocsCtx, json, UUID } from '../../../../lib/loadDocsServer.js';
import { isMissing } from '../../../../lib/facilityServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Note not found.' }, 404);
  let body = {}; try { body = await req.json(); } catch { /* reason is optional */ }
  const { data: n, error } = await x.svc.from('facility_notes').select('id,hidden').eq('id', params.id).maybeSingle();
  if (error) return isMissing(error) ? json({ error: 'Reports aren’t set up yet.' }, 409) : json({ error: 'Couldn’t send the report.' }, 500);
  if (!n || n.hidden) return json({ error: 'Note not found.' }, 404);
  const reason = String(body?.reason ?? '').trim().slice(0, 300) || null;
  const ins = await x.svc.from('facility_note_reports').insert({ note_id: n.id, reporter_id: x.c.user.id, reason });
  if (ins.error && ins.error.code !== '23505') return json({ error: 'Couldn’t send the report.' }, 500);
  return json({ ok: true });
}
