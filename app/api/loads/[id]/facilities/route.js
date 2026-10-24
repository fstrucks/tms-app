// GET → { facilities: { [stopId]: { facility_id, name, avg, count, tips: [{ text, at }] } } } for the load's stops
// that match a known facility. Same access as stop check-off. Public, anonymous data only.
import { loadDocsCtx, json } from '../../../../lib/loadDocsServer.js';
import { loadForStopTimes } from '../../../../lib/stopTimesServer.js';
import { summaries, tipsFor, isMissing } from '../../../../lib/facilityServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const r = await loadForStopTimes(x, params?.id); if (r.res) return r.res;
  const stops = (r.load.stops || []).filter((s) => s.facility_id);
  if (!stops.length) return json({ facilities: {} });
  const s = await summaries(x.svc, stops.map((t) => t.facility_id));
  if (s.error) return isMissing(s.error) ? json({ facilities: {}, setupNeeded: true }) : json({ error: 'Couldn’t load facility reviews.' }, 500);
  const tips = new Map();
  for (const id of s.map.keys()) tips.set(id, await tipsFor(x.svc, id));
  const own = await x.svc.from('facility_reviews').select('stop_id,stars,hidden').eq('author_id', x.c.user.id).in('stop_id', stops.map((t) => t.id));
  const mine = new Map();
  if (!own.error) for (const row of own.data || []) if (row.stars != null && !row.hidden) mine.set(row.stop_id, Number(row.stars));
  const out = {};
  for (const t of stops) { const f = s.map.get(t.facility_id); if (f) out[t.id] = { facility_id: t.facility_id, ...f, tips: tips.get(t.facility_id) || [], my_stars: mine.get(t.id) ?? null }; }
  return json({ facilities: out });
}
