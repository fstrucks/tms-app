// GET → { facility: { id, name, address_line1, city, state, zip }, avg, count, reviews: [public fields only] }.
// Any signed-in user (the directory is shared across companies). Reviews are anonymous; hidden ones are excluded.
import { loadDocsCtx, json, UUID } from '../../../lib/loadDocsServer.js';
import { summaries, publicReviews, isMissing } from '../../../lib/facilityServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  if (!UUID.test(params?.id || '')) return json({ error: 'Facility not found.' }, 404);
  const { data: f, error } = await x.svc.from('facilities').select('id,name,address_line1,city,state,zip').eq('id', params.id).maybeSingle();
  if (error) return isMissing(error) ? json({ error: 'Facility reviews aren’t set up yet.', setupNeeded: true }, 409) : json({ error: 'Couldn’t load this facility.' }, 500);
  if (!f) return json({ error: 'Facility not found.' }, 404);
  const [s, r] = await Promise.all([summaries(x.svc, [f.id]), publicReviews(x.svc, f.id, 200)]);
  if (s.error || r.error) return json({ error: 'Couldn’t load reviews.' }, 500);
  const sum = s.map.get(f.id) || { avg: null, count: 0 };
  return json({ facility: f, avg: sum.avg, count: sum.count, reviews: r.reviews });
}
