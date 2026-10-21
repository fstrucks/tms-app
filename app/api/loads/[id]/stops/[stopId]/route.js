// POST { action: 'done' | 'skip' | 'undo' } → { ok, stop, status }
// Marks one stop picked up / delivered / done, skipped, or un-marks it. Allowed: owner / management / dispatcher on any
// company load, or the load's assigned driver. The role is resolved for the LOAD's company (packet_role(load owner)),
// not the caller's company profile: 36fc0fc filtered loads.user_id = company_profiles.owner_id, which 404s whenever
// those differ (Marc, Oct 20: owner via company_members, load under his own user id). Assigned driver always allowed.
// The write uses the service role, then the stop is RE-READ and checked: a write that changed nothing is an error.
// Marking the first pickup done moves booked / dispatched → in_transit; undoing it (nothing else marked) moves
// in_transit → dispatched. Before migration 20261020000400: 409 { setupNeeded } (the UI hides the buttons).
import { loadDocsCtx, json, UUID } from '../../../../../lib/loadDocsServer';
import { isMissing } from '../../../../../lib/truckServer';
import { canCompleteStops, planStopAction, supportsStopCompletion } from '../../../../../lib/stopProgress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const SETUP = { error: 'Stop check-off needs a database update that hasn’t been applied yet.', setupNeeded: true };
const NOT_SAVED = { error: 'That didn’t save. Please try again.', notSaved: true };
const clean = ({ geocode_address, ...r } = {}) => r; // eslint-disable-line no-unused-vars

// TEMP (Oct 20 prod debugging): one line per request, status code + reason only (no ids, names or emails).
const out = (body, status, reason) => { console.log(`[stops] ${status} ${reason}`); return json(body, status); };

export async function POST(req, { params, deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) { console.log(`[stops] ${x.res.status} ctx`); return x.res; }
  const { c, svc } = x;
  if (!UUID.test(params?.id || '') || !UUID.test(params?.stopId || '')) return out({ error: 'Stop not found.' }, 404, 'bad_id');
  let body; try { body = await req.json(); } catch { return out({ error: 'Bad request.' }, 400, 'bad_body'); }
  const { data: load, error: lErr } = await svc.from('loads').select('id,user_id,status,assigned_driver_user_id, stops(*)').eq('id', params.id).maybeSingle();
  if (lErr) return out({ error: 'Couldn’t load this load.' }, 500, `load_read_${lErr.code || 'err'}`);
  if (!load) return out({ error: 'Load not found.' }, 404, 'no_load');
  let role = load.user_id === c.ownerId ? c.role : null;
  if (!role && c.uc) {
    const { data: r2 } = await c.uc.rpc('packet_role', { p_owner: load.user_id });
    role = typeof r2 === 'string' ? r2 : null;
  }
  // The assigned driver may always check off his own load's stops, even when no company role resolves for the load's
  // owner (e.g. loads.user_id differs from the company profile's owner_id).
  if (!role && load.assigned_driver_user_id === c.user.id) role = 'driver';
  if (!role || !canCompleteStops(role, load, c.user.id)) return out({ error: 'Load not found.' }, 404, 'no_role');
  if (!supportsStopCompletion(load)) return out(SETUP, 409, 'no_completion_columns_in_read');
  const plan = planStopAction(load, params.stopId, body?.action, { now: (deps?.now ? new Date(deps.now()) : new Date()).toISOString(), userId: c.user.id });
  if (plan.error) return out({ error: plan.error }, plan.code, 'plan');
  if (plan.noop) return out({ ok: true, already: true, stop: clean((load.stops || []).find((s) => s.id === params.stopId)), status: load.status }, 200, 'noop');

  const upd = await svc.from('stops').update(plan.stopPatch).eq('id', params.stopId).eq('load_id', load.id).select('id');
  if (upd.error) return isMissing(upd.error) ? out(SETUP, 409, `update_missing_${upd.error.code || ''}`) : out({ error: 'Couldn’t save the stop.' }, 500, `update_${upd.error.code || 'err'}`);
  if (!upd.data?.length) return out(NOT_SAVED, 500, 'update_0_rows');
  const { data: stop, error: rErr } = await svc.from('stops').select('*').eq('id', params.stopId).eq('load_id', load.id).maybeSingle();
  const want = plan.stopPatch.completed_at;
  if (rErr || !stop || (want ? !stop.completed_at || stop.completion !== plan.stopPatch.completion : stop.completed_at != null)) {
    return out(NOT_SAVED, 500, `reread_mismatch_${rErr?.code || ''}`);
  }
  let status = load.status;
  if (plan.status) {
    const { data: s2, error: uErr } = await svc.from('loads').update({ status: plan.status }).eq('id', load.id).eq('user_id', load.user_id)
      .in('status', plan.fromStatuses).select('status').maybeSingle();
    if (uErr) console.error('[stops] status', uErr.code);
    else if (s2?.status) status = s2.status;
  }
  return out({ ok: true, stop: clean(stop), status }, 200, `saved_${body.action}`);
}
