// Home card map panel (Panel 2). Server only: ORS_API_KEY never reaches the browser.
// GET  → stops + the stored load route (never calls OpenRouteService).
// POST → { lat, lng, accuracy_m, stop_id } in the BODY → live miles + drive time to that stop (cached, rate-limited).
// PRIVACY: driver location is never stored or logged; errors log codes only. Access via public.visible_loads(), so a
// driver only reaches their own assigned loads.
import { json } from '../../../../lib/truckServer';
import { withDeadline } from '../../../../lib/loadRouteServer';
import { etaCtx, storedRoute, liveEta } from '../../../../lib/loadEtaServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;
const DEADLINE_MS = 14_000;

function early(c) {
  if (c.res) return c.res;
  if (c.notFound) return json({ error: 'Load not found.', state: 'failed' }, 404);
  if (c.error) return json({ error: c.error, state: 'failed', retry: true }, 500);
  return null;
}
// Never logs the request body (coordinates). Only the error's name.
const crashed = (where, e) => { console.error(`[eta] ${where}`, String(e?.name || 'Error')); return json({ error: 'Couldn’t load live miles. Try again.', state: 'failed', retry: true }, 500); };
const late = () => json({ state: 'error', code: 'timeout', retryInMs: 600000 }, 503);

export async function GET(req, { params, deps } = {}) {
  return withDeadline((async () => {
    try {
      const c = await etaCtx(req, params?.id, deps); const e = early(c); if (e) return e;
      return json(await storedRoute(c, deps?.eta));
    } catch (e) { return crashed('GET', e); }
  })(), deps?.deadlineMs ?? DEADLINE_MS, late);
}

export async function POST(req, { params, deps } = {}) {
  return withDeadline((async () => {
    try {
      let body = null; try { body = await req.json(); } catch {}
      const c = await etaCtx(req, params?.id, deps); const e = early(c); if (e) return e;
      const r = await liveEta(c, body || {}, deps?.eta);
      return json(r.body, r.status || 200);
    } catch (e) { return crashed('POST', e); }
  })(), deps?.deadlineMs ?? DEADLINE_MS, late);
}
