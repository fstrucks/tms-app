// GET → { facilities: { [stopId]: { facility_id, name, avg, count, tips: [{ text, at }] } } } for the load's stops
// that match a known facility. Same access as stop check-off. Public, anonymous data only.
import { loadDocsCtx, json } from '../../../../lib/loadDocsServer.js';
import { loadForStopTimes } from '../../../../lib/stopTimesServer.js';
import { summaries, publicReviews, isMissing } from '../../../../lib/facilityServer.js';
import { displaySummary, recentTips } from '../../../../lib/facilityReviews.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const r = await loadForStopTimes(x, params?.id); if (r.res) return r.res;
  const stops = (r.load.stops || []).filter((s) => s.facility_id);
  if (!stops.length) return json({ facilities: {} });
  const s = await summaries(x.svc, stops.map((t) => t.facility_id));
  if (s.error) return isMissing(s.error) ? json({ facilities: {}, setupNeeded: true }) : json({ error: 'Couldn’t load facility reviews.' }, 500);
  const pack = new Map();
  for (const id of s.map.keys()) {
    const base = s.map.get(id);
    const pr = await publicReviews(x.svc, id, 200);
    if (pr.error) pack.set(id, { avg: base.avg, count: base.count, tips: [] });
    else {
      const shown = displaySummary(base.avg, base.count, pr.reviews);
      pack.set(id, { avg: shown.avg, count: shown.count, tips: recentTips(pr.reviews) });
    }
  }
  const own = await x.svc.from('facility_reviews').select('stop_id,stars,hidden').eq('author_id', x.c.user.id).in('stop_id', stops.map((t) => t.id));
  const mine = new Map();
  if (!own.error) for (const row of own.data || []) if (row.stars != null && !row.hidden) mine.set(row.stop_id, Number(row.stars));
  const out = {};
  for (const t of stops) {
    const f = s.map.get(t.facility_id);
    const p = pack.get(t.facility_id);
    if (f && p) out[t.id] = { facility_id: t.facility_id, ...f, avg: p.avg, count: p.count, tips: p.tips, my_stars: mine.get(t.id) ?? null };
  }
  return json({ facilities: out });
}
