// Delays at a load's stops (stop_delays). Same access as stop check-off: company staff (owner / management /
// dispatcher) or the load's assigned driver. Writes use the service role, always scoped to this load's stops.
//   GET                                   → { delays }
//   POST   { stop_id, reason, note?, started_at?, ended_at? } → { delay }
//   PATCH  { id, reason, note?, started_at, ended_at? }        → { delay }
//   DELETE { id }                                              → { ok }
// Before migration 20261022170000: 409 { setupNeeded } (the UI hides Delays).
import { loadDocsCtx, json, UUID } from '../../../../lib/loadDocsServer';
import { loadForStopTimes } from '../../../../lib/stopTimesServer';
import { cleanDelay, isMissingTable } from '../../../../lib/stopDelays';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const SETUP = { error: 'Delays need a database update that hasn’t been applied yet.', setupNeeded: true };
const COLS = 'id,stop_id,load_id,reason,note,started_at,ended_at,created_by,created_at,updated_at';

async function ctx(req, params, deps) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x;
  const r = await loadForStopTimes(x, params?.id); if (r.res) return r;
  return { ...x, load: r.load, now: (deps?.now ? new Date(deps.now()) : new Date()).toISOString() };
}
const body = async (req) => { try { return await req.json(); } catch { return null; } };
const fail = (e, what) => (isMissingTable(e) ? json(SETUP, 409) : (console.error(`[delays] ${what}`, e?.code), json({ error: 'Couldn’t save the delay. Please try again.' }, 500)));

export async function GET(req, { params, deps } = {}) {
  const x = await ctx(req, params, deps); if (x.res) return x.res;
  const { data, error } = await x.svc.from('stop_delays').select(COLS).eq('load_id', x.load.id).order('started_at', { ascending: true });
  if (error) return isMissingTable(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load delays.' }, 500);
  return json({ delays: data || [] });
}

export async function POST(req, { params, deps } = {}) {
  const x = await ctx(req, params, deps); if (x.res) return x.res;
  const b = await body(req); if (!b) return json({ error: 'Bad request.' }, 400);
  if (!UUID.test(b.stop_id || '') || !(x.load.stops || []).some((s) => s.id === b.stop_id)) return json({ error: 'Stop not found.' }, 404);
  const c = cleanDelay(b, x.now); if (c.error) return json({ error: c.error }, 422);
  const { data, error } = await x.svc.from('stop_delays').insert({ ...c.row, stop_id: b.stop_id, load_id: x.load.id, owner_id: x.load.user_id, created_by: x.c.user.id }).select(COLS).maybeSingle();
  if (error || !data) return fail(error, 'insert');
  return json({ delay: data });
}

async function own(x, id) {
  if (!UUID.test(id || '')) return null;
  const { data, error } = await x.svc.from('stop_delays').select(COLS).eq('id', id).eq('load_id', x.load.id).maybeSingle();
  return error ? { error } : data;
}

export async function PATCH(req, { params, deps } = {}) {
  const x = await ctx(req, params, deps); if (x.res) return x.res;
  const b = await body(req); if (!b) return json({ error: 'Bad request.' }, 400);
  const cur = await own(x, b.id); if (cur?.error) return fail(cur.error, 'read'); if (!cur) return json({ error: 'Delay not found.' }, 404);
  const c = cleanDelay({ reason: cur.reason, note: cur.note, started_at: cur.started_at, ended_at: cur.ended_at, ...b }, x.now); if (c.error) return json({ error: c.error }, 422);
  const { data, error } = await x.svc.from('stop_delays').update(c.row).eq('id', cur.id).eq('load_id', x.load.id).select(COLS).maybeSingle();
  if (error || !data) return fail(error, 'update');
  return json({ delay: data });
}

export async function DELETE(req, { params, deps } = {}) {
  const x = await ctx(req, params, deps); if (x.res) return x.res;
  const b = await body(req); if (!b) return json({ error: 'Bad request.' }, 400);
  const cur = await own(x, b.id); if (cur?.error) return fail(cur.error, 'read'); if (!cur) return json({ error: 'Delay not found.' }, 404);
  const { error } = await x.svc.from('stop_delays').delete().eq('id', cur.id).eq('load_id', x.load.id);
  if (error) return fail(error, 'delete');
  return json({ ok: true });
}
