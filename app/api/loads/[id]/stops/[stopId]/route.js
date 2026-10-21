// POST { action: 'done' | 'skip' | 'undo' } → { ok, stop, status }
// Marks one stop picked up / delivered / done, skipped, or un-marks it. Allowed: owner / management / dispatcher on any
// company load, or the load's assigned driver (checked here; the write uses the service role filtered to the company).
// Marking the first pickup done moves a booked / dispatched load to in_transit.
// Before migration 20261020000400 the stops have no completed_at column: 409 { setupNeeded } (the UI hides the buttons).
import { loadDocsCtx, json, UUID } from '../../../../../lib/loadDocsServer';
import { isMissing } from '../../../../../lib/truckServer';
import { canCompleteStops, planStopAction, supportsStopCompletion, START_STATUSES } from '../../../../../lib/stopProgress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const SETUP = { error: 'Stop check-off needs a database update that hasn’t been applied yet.', setupNeeded: true };

export async function POST(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const { c, svc } = x;
  if (!UUID.test(params?.id || '') || !UUID.test(params?.stopId || '')) return json({ error: 'Stop not found.' }, 404);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const { data: load, error: lErr } = await svc.from('loads').select('id,user_id,status,assigned_driver_user_id, stops(*)')
    .eq('id', params.id).eq('user_id', c.ownerId).maybeSingle();
  if (lErr) return json({ error: 'Couldn’t load this load.' }, 500);
  if (!load || !canCompleteStops(c.role, load, c.user.id)) return json({ error: 'Load not found.' }, 404);
  if (!supportsStopCompletion(load)) return json(SETUP, 409);
  const plan = planStopAction(load, params.stopId, body?.action, { now: (deps?.now ? new Date(deps.now()) : new Date()).toISOString(), userId: c.user.id });
  if (plan.error) return json({ error: plan.error }, plan.code);
  const { data: stop, error: sErr } = await svc.from('stops').update(plan.stopPatch).eq('id', params.stopId).eq('load_id', load.id).select('*').maybeSingle();
  if (sErr) return isMissing(sErr) ? json(SETUP, 409) : json({ error: 'Couldn’t save the stop.' }, 500);
  if (!stop) return json({ error: 'Stop not found.' }, 404);
  let status = load.status;
  if (plan.status) {
    const { data: s2, error: uErr } = await svc.from('loads').update({ status: plan.status }).eq('id', load.id).eq('user_id', c.ownerId)
      .in('status', START_STATUSES).select('status').maybeSingle();
    if (uErr) console.error('[stops] status', uErr.code);
    else if (s2?.status) status = s2.status;
  }
  const { geocode_address, ...out } = stop; // eslint-disable-line no-unused-vars
  return json({ ok: true, stop: out, status });
}
