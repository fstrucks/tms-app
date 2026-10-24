// GET → { facility: { id, name, address_line1, city, state, zip }, avg, count, reviews: [public fields only],
//   wait: { samples, avg, hourly, daily } | null, notes: [{ id, body, created_at }] | null, canAddNote }.
// Any signed-in user (the directory is shared across companies). Reviews are anonymous; hidden ones are excluded.
import { loadDocsCtx, json, UUID } from '../../../lib/loadDocsServer.js';
import { summaries, publicReviews, waitStats, publicNotes, isMissing } from '../../../lib/facilityServer.js';
import { displaySummary } from '../../../lib/facilityReviews.js';
import { shapeWaitStats, canAddFacilityNote } from '../../../lib/facilityPage.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Facility not found.' }, 404);
  const { data: f, error } = await x.svc.from('facilities').select('id,name,address_line1,city,state,zip').eq('id', params.id).maybeSingle();
  if (error) return isMissing(error) ? json({ error: 'Facility reviews aren’t set up yet.', setupNeeded: true }, 409) : json({ error: 'Couldn’t load this facility.' }, 500);
  if (!f) return json({ error: 'Facility not found.' }, 404);
  const [s, r, w, n] = await Promise.all([summaries(x.svc, [f.id]), publicReviews(x.svc, f.id, 200), waitStats(x.svc, f.id), publicNotes(x.svc, f.id, 100)]);
  if (s.error || r.error) return json({ error: 'Couldn’t load reviews.' }, 500);
  if (w.error) console.error('[facility] wait stats', w.error.code || '', String(w.error.message || '').slice(0, 160));
  if (n.error) console.error('[facility] notes', n.error.code || '', String(n.error.message || '').slice(0, 160));
  const sum = s.map.get(f.id) || { avg: null, count: 0 };
  const shown = displaySummary(sum.avg, sum.count, r.reviews);
  return json({ facility: f, avg: shown.avg, count: shown.count, reviews: r.reviews,
    wait: w.rows ? shapeWaitStats(w.rows) : null, notes: n.notes || null, notesSetupNeeded: !!n.missing, canAddNote: canAddFacilityNote(x.c.role) });
}
