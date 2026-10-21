// PR #115: per-stop completion ("Picked up" / "Delivered" / "Done" / "Skip"). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { nextStopIndex } from '../../app/lib/homeCurrentLoad.js';
import { supportsStopCompletion, completedNextIndex, stopActionLabel, canCompleteStops, planStopAction, lastCompletedStop } from '../../app/lib/stopProgress.js';
import * as ROUTE from '../../app/api/loads/[id]/stops/[stopId]/route.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', DRIVER2 = '00000000-0000-4000-8000-0000000000a3', DISP = '00000000-0000-4000-8000-0000000000a5', OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1', XL = '00000000-0000-4000-8000-0000000000b9';
const S1 = '00000000-0000-4000-8000-0000000000d1', S2 = '00000000-0000-4000-8000-0000000000d2', S3 = '00000000-0000-4000-8000-0000000000d3', SX = '00000000-0000-4000-8000-0000000000d9';
const H = 3600e3, NOW = Date.parse('2026-10-20T20:00:00Z');
const stop = (id, seq, type, extra = {}) => ({ id, load_id: L1, sequence: seq, stop_type: type, appointment_start: new Date(NOW + seq * H).toISOString(), completed_at: null, completion: null, completed_by: null, ...extra });

test('nextStopIndex: first stop not completed, even when status is still dispatched; fallback guess without completion data', () => {
  const st = [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery'), stop(S3, 3, 'delivery')];
  assert.equal(nextStopIndex({ status: 'dispatched', stops: st }, NOW), 0); // no completion data → old guess
  const picked = [{ ...st[0], completed_at: '2026-10-20T19:00:00Z', completion: 'done' }, st[1], st[2]];
  assert.equal(nextStopIndex({ status: 'dispatched', stops: picked }, NOW), 1, 'Marc: picked up → next is the delivery');
  assert.equal(nextStopIndex({ status: 'in_transit', stops: picked.map((x) => ({ ...x, completed_at: x.completed_at || 'x', completion: 'done' })) }, NOW), 2, 'all done → last');
  const legacy = st.map(({ completed_at, completion, completed_by, ...r }) => r); // before the migration
  assert.equal(nextStopIndex({ status: 'in_transit', stops: legacy }, NOW), 1);
  assert.equal(supportsStopCompletion({ stops: legacy }), false);
  assert.equal(supportsStopCompletion({ stops: st }), true);
  assert.equal(completedNextIndex({ stops: st }), 0); // columns present, nothing marked → first stop
});

test('labels, roles, plans', () => {
  assert.equal(stopActionLabel({ stop_type: 'pickup' }), 'Picked up');
  assert.equal(stopActionLabel({ stop_type: 'delivery' }), 'Delivered');
  assert.equal(stopActionLabel({ stop_type: 'stop' }), 'Done');
  const load = { status: 'dispatched', assigned_driver_user_id: DRIVER, stops: [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')] };
  for (const r of ['owner', 'management', 'dispatcher']) assert.ok(canCompleteStops(r, load, OTHER));
  assert.ok(canCompleteStops('driver', load, DRIVER)); assert.ok(!canCompleteStops('driver', load, DRIVER2));
  assert.equal(planStopAction(load, S1, 'done', { now: 'T' }).status, 'in_transit');
  assert.equal(planStopAction(load, S1, 'skip', { now: 'T' }).status, null);
  assert.equal(planStopAction(load, S2, 'done', { now: 'T' }).status, null);
  assert.equal(planStopAction({ ...load, status: 'in_transit' }, S1, 'done', { now: 'T' }).status, null);
  assert.equal(planStopAction(load, S1, 'undo').noop, true);
  assert.equal(planStopAction(load, SX, 'done').code, 404);
  assert.equal(planStopAction(load, S1, 'nope').code, 400);
  assert.equal(lastCompletedStop({ stops: [{ ...load.stops[0], completed_at: '2026-10-20T01:00:00Z' }, { ...load.stops[1], completed_at: '2026-10-20T02:00:00Z' }] }).id, S2);
});

// packet_role(p_owner): the caller's role only in OWNER's company (null elsewhere), like the real function.
function scopeRole(uc, role) { const rpc = uc.rpc.bind(uc); uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === OWNER ? role : null, error: null }) : rpc(fn, a)); }
function ctx(role, userId, { legacy = false } = {}) {
  const st = [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')].map((x) => (legacy ? (({ completed_at, completion, completed_by, ...r }) => r)(x) : x));
  const svc = fakeSupabase({ tables: {
    loads: [{ id: L1, user_id: OWNER, status: 'dispatched', assigned_driver_user_id: DRIVER }, { id: XL, user_id: OTHER, status: 'dispatched' }],
    stops: [...st, { id: SX, load_id: XL, sequence: 1, stop_type: 'pickup', completed_at: null }] } });
  const from = svc.from.bind(svc);
  svc.from = (t) => {
    const q = from(t);
    if (t === 'loads') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data && !r.data.status_only) r.data = { ...r.data, stops: svc.db?.stops?.filter((s) => s.load_id === r.data.id) ?? st }; return r; }; }
    return q;
  };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  scopeRole(uc, role);
  return { svc, deps: { mkUserClient: () => uc, sb: svc, now: () => NOW } };
}
const call = async (c, stopId, action, loadId = L1) => { const r = await ROUTE.POST(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ action }) }), { params: { id: loadId, stopId }, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('route: assigned driver marks pickup → stop done + load in_transit; undo clears it', async () => {
  const c = ctx('driver', DRIVER);
  let r = await call(c, S1, 'done');
  assert.equal(r.status, 200); assert.equal(r.j.stop.completion, 'done'); assert.ok(r.j.stop.completed_at); assert.equal(r.j.status, 'in_transit');
  r = await call(c, S1, 'done'); assert.equal(r.status, 200); assert.equal(r.j.already, true); assert.equal(r.j.stop.completion, 'done'); // second tap = success + current row
  r = await call(c, S1, 'undo'); assert.equal(r.status, 200); assert.equal(r.j.stop.completed_at, null); assert.equal(r.j.status, 'dispatched'); // undo of first pickup
});

test('route: dispatcher can skip; other driver and other company get 404; no sign-in 401', async () => {
  let r = await call(ctx('dispatcher', DISP), S1, 'skip'); assert.equal(r.status, 200); assert.equal(r.j.stop.completion, 'skipped'); assert.equal(r.j.status, 'dispatched');
  r = await call(ctx('driver', DRIVER2), S1, 'done'); assert.equal(r.status, 404);
  r = await call(ctx('owner', OWNER), SX, 'done', XL); assert.equal(r.status, 404);
  const res = await ROUTE.POST(new Request('http://x', { method: 'POST', body: '{}' }), { params: { id: L1, stopId: S1 }, deps: ctx('owner', OWNER).deps });
  assert.equal(res.status, 401);
});

test('route: before the migration → 409 setupNeeded (UI hides the buttons)', async () => {
  const r = await call(ctx('owner', OWNER, { legacy: true }), S1, 'done');
  assert.equal(r.status, 409); assert.equal(r.j.setupNeeded, true);
});

test('UI wiring: Home card and load page render StopActions; theme colors only', () => {
  const home = readFileSync(new URL('../../app/components/HomeCurrentLoad.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8');
  const comp = readFileSync(new URL('../../app/components/StopActions.js', import.meta.url), 'utf8');
  assert.match(home, /<StopActions /); assert.match(page, /<StopActions /);
  assert.match(comp, /supportsStopCompletion\(load\)/); assert.match(comp, /Skip to next stop/); assert.ok(!/ConfirmButton/.test(comp)); assert.match(comp, /useState\(null\); \/\/ one confirm at a time/);
  assert.ok(!/(?<![A-Za-z0-9 ])#[0-9a-f]{3,6}\b|rgba?\(/i.test(comp));
});

test('in_transit with no marks = pickup implied done; Undo path uses dispatched so the pickup comes back', () => {
  const st = [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')];
  // Marc (prod): in_transit with nothing ever marked → pickup implicitly done, next = stop 2
  assert.equal(nextStopIndex({ status: 'in_transit', stops: st }, NOW), 1);
  // after Undo of the pickup the server moves the load back to dispatched → pickup shows again
  assert.equal(nextStopIndex({ status: 'dispatched', stops: st }, NOW + 20 * H), 0);
  // columns absent → old appointment guess unchanged
  const legacy = st.map(({ completed_at, completion, completed_by, ...r }) => r);
  assert.equal(nextStopIndex({ status: 'in_transit', stops: legacy }, NOW), 1);
  assert.equal(stopActionLabel(st[nextStopIndex({ status: 'dispatched', stops: st }, NOW)]), 'Picked up');
});

test('QA #115 nit (a): a repeat tap is success and returns the server row; undo of an open stop too', async () => {
  const c = ctx('driver', DRIVER);
  assert.equal((await call(c, S1, 'done')).status, 200);
  const again = await call(c, S1, 'done');
  assert.equal(again.status, 200); assert.equal(again.j.ok, true); assert.equal(again.j.already, true); assert.ok(again.j.stop.completed_at);
  assert.equal((await call(c, S1, 'undo')).j.stop.completed_at, null);
  const undo2 = await call(c, S1, 'undo');
  assert.equal(undo2.status, 200); assert.equal(undo2.j.already, true); assert.equal(undo2.j.stop.completed_at, null);
  const comp = readFileSync(new URL('../../app/components/StopActions.js', import.meta.url), 'utf8');
  assert.match(comp, /onRefresh\?\.\(\)/);
  const home = readFileSync(new URL('../../app/components/HomeCurrentLoad.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8');
  assert.match(home, /onRefresh=\{load\}/); assert.match(page, /onRefresh=\{\(\) => fetchRef\.current\?\.\(\)\}/);
});

function patchSvc(c, fn) { const from = c.svc.from.bind(c.svc); c.svc.from = (t) => fn(t, from(t)); return c; }

test('prod fix: owner whose first company profile is another company still saves on his own load', async () => {
  const c = ctx('owner', OWNER);
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p-other', owner_id: OTHER }, { id: 'p1', owner_id: OWNER }] }, user: { id: OWNER }, role: 'owner' });
  const rpc = uc.rpc.bind(uc); // member ('management') of OTHER's company, owner of his own
  uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === OWNER ? 'owner' : a?.p_owner === OTHER ? 'management' : null, error: null }) : rpc(fn, a));
  c.deps.mkUserClient = () => uc;
  const r = await call(c, S1, 'done');
  assert.equal(r.status, 200); assert.equal(r.j.stop.completion, 'done');
  const row = c.svc.db?.stops?.find((x) => x.id === S1);
  if (row) assert.ok(row.completed_at, 'persisted in the stops table');
});

test('prod fix: an update that changes 0 rows, or a re-read that disagrees, is a real error (not success)', async () => {
  const zero = patchSvc(ctx('owner', OWNER), (t, q) => { if (t === 'stops') { const u = q.update.bind(q); q.update = (p) => { const r = u(p); r.select = () => Promise.resolve({ data: [], error: null }); return r; }; } return q; });
  let r = await call(zero, S1, 'done');
  assert.equal(r.status, 500); assert.equal(r.j.notSaved, true); assert.match(r.j.error, /didn’t save/);
  const stale = patchSvc(ctx('owner', OWNER), (t, q) => { if (t === 'stops') { const u = q.update.bind(q); q.update = () => u({}); } return q; }); // write is a no-op
  r = await call(stale, S1, 'done');
  assert.equal(r.status, 500); assert.equal(r.j.notSaved, true);
});

test('UI: one confirm at a time; Yes calls the API; failures show an error', () => {
  const comp = readFileSync(new URL('../../app/components/StopActions.js', import.meta.url), 'utf8');
  assert.match(comp, /pending \? \(/); // confirm replaces both buttons
  assert.match(comp, /data-testid="stop-confirm-yes"[^>]*onClick=\{\(\) => act\(target, pending\)\}/);
  assert.match(comp, /if \(!r\.ok\) \{ setErr\(r\.error\); return false; \}/);
  assert.match(comp, /catch \{ return \{ ok: false, error: 'Couldn’t reach the server/);
  const map = readFileSync(new URL('../../app/components/LoadMapPanel.js', import.meta.url), 'utf8');
  assert.match(map, /doneIds=\{supportsStopCompletion\(load\)/);
});

test('prod (Marc): profile owner_id ≠ loads.user_id — owner-member who is also the assigned driver still saves', async () => {
  // Marc's profile names another owner id; his membership role there is owner; the load sits under his own user id.
  const PROFILE_OWNER = '00000000-0000-4000-8000-0000000000e1';
  const c = ctx('owner', DRIVER);
  c.svc.from = ((from) => (t) => { const q = from(t); return q; })(c.svc.from);
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: PROFILE_OWNER }] }, user: { id: DRIVER }, role: 'owner' });
  const rpc = uc.rpc.bind(uc);
  uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === PROFILE_OWNER ? 'owner' : null, error: null }) : rpc(fn, a));
  c.deps.mkUserClient = () => uc;
  // load L1 belongs to OWNER (≠ PROFILE_OWNER) and DRIVER is assigned → allowed as assigned driver
  const r = await call(c, S1, 'done');
  assert.equal(r.status, 200); assert.equal(r.j.stop.completion, 'done');
  // not assigned, no role for the load's owner → 404
  const c2 = ctx('owner', DRIVER2); const uc2 = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: PROFILE_OWNER }] }, user: { id: DRIVER2 }, role: 'owner' });
  const rpc2 = uc2.rpc.bind(uc2); uc2.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === PROFILE_OWNER ? 'owner' : null, error: null }) : rpc2(fn, a));
  c2.deps.mkUserClient = () => uc2;
  assert.equal((await call(c2, S1, 'done')).status, 404);
});

test('prod suspect: server read without completion keys (stale PostgREST schema cache) → 409, and the UI now says so instead of hiding', async () => {
  // Client data (visible_loads → to_jsonb) has the keys, so the buttons show; the route's PostgREST embed stops(*)
  // comes from the schema cache and, before `notify pgrst, 'reload schema'`, lacks them.
  const c = ctx('owner', OWNER, { legacy: true });
  const r = await call(c, S1, 'done');
  assert.equal(r.status, 409); assert.equal(r.j.setupNeeded, true);
  const comp = readFileSync(new URL('../../app/components/StopActions.js', import.meta.url), 'utf8');
  assert.ok(!/setHidden\(true\)/.test(comp), 'no silent hide');
  assert.match(comp, /isn’t available on the server yet\. Nothing was saved\./);
});
