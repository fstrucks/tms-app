// POST { body } → { note: { id, body, created_at } }. Any signed-in owner, Management, Dispatch or driver can add a
// lasting note to a facility (300 characters; no phone numbers, emails, links or profanity). Shown anonymously.
import { loadDocsCtx, json, UUID } from '../../../../lib/loadDocsServer.js';
import { isMissing } from '../../../../lib/facilityServer.js';
import { cleanFacilityNote, canAddFacilityNote, publicNote } from '../../../../lib/facilityPage.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  if (!canAddFacilityNote(x.c.role)) return json({ error: 'Not allowed.' }, 403);
  if (!UUID.test(params?.id || '')) return json({ error: 'Facility not found.' }, 404);
  let body = {}; try { body = await req.json(); } catch { /* empty body → validation error */ }
  const c = cleanFacilityNote(body); if (c.error) return json({ error: c.error, reason: c.reason || null }, 400);
  const { data: f, error } = await x.svc.from('facilities').select('id').eq('id', params.id).maybeSingle();
  if (error) return json({ error: 'Couldn’t save the note.' }, 500);
  if (!f) return json({ error: 'Facility not found.' }, 404);
  const { data: co } = await x.svc.from('company_profiles').select('id').eq('owner_id', x.c.ownerId).maybeSingle();
  const ins = await x.svc.from('facility_notes').insert({ facility_id: f.id, author_id: x.c.user.id, company_id: co?.id || null, body: c.row.body }).select('id,body,created_at').maybeSingle();
  if (ins.error) return isMissing(ins.error) ? json({ error: 'Facility notes aren’t set up yet.', setupNeeded: true }, 409) : json({ error: 'Couldn’t save the note.' }, 500);
  return json({ note: publicNote(ins.data) });
}
