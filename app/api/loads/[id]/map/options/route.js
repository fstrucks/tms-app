// Route options, Phase 1 (display only): Fastest (stored route) / Shortest / No tolls for a load. Same viewers as the
// map (owner + staff of the company, or the assigned driver). Reads only; no database writes, no rate in the reply.
// The browser calls this only when "Route options" is opened. ORS_API_KEY never reaches the browser.
import { json } from '../../../../../lib/truckServer';
import { mapCtx, withDeadline, HANDLER_DEADLINE_MS } from '../../../../../lib/loadRouteServer';
import { computeOptions } from '../../../../../lib/routeOptionsServer';
import { rateGate } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const late = () => json({ state: 'failed', error: 'Route options took too long. Try again.', message: 'Route options took too long. Try again.' }, 503);

export async function POST(req, { params, deps } = {}) {
  return withDeadline((async () => {
    try {
      const c = await mapCtx(req, deps); if (c.res) return c.res;
      const gate = await rateGate(c, params?.id);
      if (gate.hidden) return json({ state: 'not_found', error: 'Load not found.' }, 404);
      const r = await computeOptions(c.db, c.ownerId, params?.id, c.user?.id, deps?.options || {});
      if (r.state === 'not_found') return json({ ...r, error: 'Load not found.' }, 404);
      return r.state === 'busy' ? json({ ...r, error: r.message }, 429) : json(r, 200);
    } catch (e) {
      console.error('[map options]', String(e?.name || ''), String(e?.message || e).slice(0, 200));
      return json({ state: 'failed', error: 'Couldn’t load route options. Try again.', message: 'Couldn’t load route options. Try again.' }, 500);
    }
  })(), deps?.deadlineMs ?? HANDLER_DEADLINE_MS, late);
}
