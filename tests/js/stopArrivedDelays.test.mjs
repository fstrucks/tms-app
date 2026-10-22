// "Arrived" step + stop delays (Oct 22). Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fakeSupabase } from './fakeSupabase.mjs';
import { planStopAction, supportsArrival, arriveLabel, minutesOnSite, fmtDuration, patchApplied } from '../../app/lib/stopProgress.js';
import { cleanDelay, delayMinutes, DELAY_REASONS, isMissingTable } from '../../app/lib/stopDelays.js';
import { stopTimeRows, stopTimesPdf } from '../../app/lib/stopTimesPdf.js';
import * as ROUTE from '../../app/api/loads/[id]/stops/[stopId]/route.js';
import * as DELAYS from '../../app/api/loads/[id]/delays/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', DRIVER2 = '00000000-0000-4000-8000-0000000000a3';
const L1 = '00000000-0000-4000-8000-0000000000b1', S1 = '00000000-0000-4000-8000-0000000000d1', S2 = '00000000-0000-4000-8000-0000000000d2';
const NOW = Date.parse('2026-10-20T20:00:00Z'), NOWISO = new Date(NOW).toISOString();
const stop = (id, seq, type, extra = {}) => ({ id, load_id: L1, sequence: seq, stop_type: type, company_name: `TEST ${type} co`, address_line1: '100 Test St', city: 'Dallas', state: 'TX', zip: '75201',
  timezone: 'America/Chicago', completed_at: null, completion: null, completed_by: null, arrived_at: null, arrived_by: null, ...extra });
const load0 = () => ({ status: 'dispatched', stops: [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')] });

test('arrive rules: labels, default now, adjustable, no status change, undo, order checks', () => {
  assert.equal(arriveLabel({ stop_type: 'pickup' }), 'Arrived at shipper'); assert.equal(arriveLabel({ stop_type: 'delivery' }), 'Arrived at receiver');
  const a = planStopAction(load0(), S1, 'arrive', { now: NOWISO, userId: DRIVER });
  assert.deepEqual(a.stopPatch, { arrived_at: NOWISO, arrived_by: DRIVER }); assert.equal(a.status, null);
  assert.equal(planStopAction(load0(), S1, 'arrive', { now: NOWISO, at: '2026-10-20T18:00:00Z' }).stopPatch.arrived_at, '2026-10-20T18:00:00.000Z');
  assert.equal(planStopAction(load0(), S1, 'arrive', { now: NOWISO, at: '2026-10-20T21:00:00Z' }).code, 422);
  assert.equal(planStopAction(load0(), S1, 'arrive', { now: NOWISO, at: '2026-09-01T00:00:00Z' }).code, 422);
  const arrived = { ...load0(), stops: [stop(S1, 1, 'pickup', { arrived_at: '2026-10-20T18:00:00Z' }), stop(S2, 2, 'delivery')] };
  assert.equal(planStopAction(arrived, S1, 'arrive', { now: NOWISO }).noop, true);
  assert.deepEqual(planStopAction(arrived, S1, 'undo_arrive', { now: NOWISO }).stopPatch, { arrived_at: null, arrived_by: null });
  assert.equal(planStopAction(arrived, S1, 'done', { now: NOWISO, at: '2026-10-20T17:00:00Z' }).code, 422, 'picked up before arrival');
  assert.equal(planStopAction(arrived, S1, 'done', { now: NOWISO }).status, 'in_transit');
  assert.equal(planStopAction(load0(), S1, 'done', { now: NOWISO }).status, 'in_transit', 'arrived is optional');
  const done = { ...load0(), status: 'in_transit', stops: [stop(S1, 1, 'pickup', { arrived_at: '2026-10-20T18:00:00Z', completed_at: '2026-10-20T19:30:00Z', completion: 'done' }), stop(S2, 2, 'delivery')] };
  assert.equal(planStopAction(done, S1, 'undo_arrive', { now: NOWISO }).code, 409);
  assert.equal(planStopAction(done, S1, 'set_time', { now: NOWISO, field: 'arrived', at: '2026-10-20T19:45:00Z' }).code, 422, 'arrival after completion');
  assert.deepEqual(planStopAction(done, S1, 'set_time', { now: NOWISO, field: 'arrived', at: '2026-10-20T17:45:00Z' }).stopPatch, { arrived_at: '2026-10-20T17:45:00.000Z', arrived_by: null });
  assert.equal(planStopAction(done, S1, 'set_time', { now: NOWISO, at: '2026-10-20T17:00:00Z' }).code, 422, 'completion before arrival');
  assert.equal(planStopAction(load0(), S1, 'set_time', { now: NOWISO, field: 'arrived', at: NOWISO }).code, 409);
  assert.equal(minutesOnSite(done.stops[0]), 90); assert.equal(fmtDuration(90), '1 h 30 min'); assert.equal(fmtDuration(45), '45 min');
  assert.equal(minutesOnSite({ ...done.stops[0], completion: 'skipped' }), null);
  assert.equal(supportsArrival(load0()), true);
  assert.equal(supportsArrival({ stops: [{ id: 'x', completed_at: null }] }), false);
  assert.ok(patchApplied({ arrived_at: '2026-10-20T18:00:00+00:00', arrived_by: 'u' }, { arrived_at: '2026-10-20T18:00:00.000Z', arrived_by: 'u' }));
  assert.ok(!patchApplied({ arrived_at: null }, { arrived_at: NOWISO }));
});

function ctx(role, userId, stops, { delays = [], noDelays = false } = {}) {
  const tables = { loads: [{ id: L1, user_id: OWNER, status: 'dispatched', broker_load_number: 'TEST-3001', assigned_driver_user_id: DRIVER }], stops, company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }] };
  if (!noDelays) tables.stop_delays = delays;
  const svc = fakeSupabase({ tables });
  const from = svc.from.bind(svc);
  svc.from = (t) => {
    if (t === 'stop_delays' && noDelays) { const err = { data: null, error: { code: '42P01', message: 'relation "stop_delays" does not exist' } }; const q = new Proxy({}, { get: (_, k) => (k === 'then' ? (r) => r(err) : () => q) }); return q; }
    const q = from(t); if (t === 'loads') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data) r.data = { ...r.data, stops: svc.db.stops.filter((s) => s.load_id === r.data.id) }; return r; }; } return q;
  };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  const rpc = uc.rpc.bind(uc); uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === OWNER ? role : null, error: null }) : rpc(fn, a));
  return { svc, deps: { mkUserClient: () => uc, sb: svc, now: () => NOW } };
}
const rq = (method, body) => new Request('http://x', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const stopCall = async (c, stopId, body) => { const r = await ROUTE.POST(rq('POST', body), { params: { id: L1, stopId }, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('route: arrive / adjust / undo arrived keep the load status; before the migration → 409, check-off still works', async () => {
  const c = ctx('driver', DRIVER, [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')]);
  let r = await stopCall(c, S1, { action: 'arrive', at: '2026-10-20T18:00:00Z' });
  assert.equal(r.status, 200); assert.equal(r.j.status, 'dispatched'); assert.equal(Date.parse(c.svc.db.stops[0].arrived_at), Date.parse('2026-10-20T18:00:00Z'));
  r = await stopCall(c, S1, { action: 'set_time', field: 'arrived', at: '2026-10-20T17:50:00Z' }); assert.equal(r.status, 200);
  r = await stopCall(c, S1, { action: 'undo_arrive' }); assert.equal(r.status, 200); assert.equal(c.svc.db.stops[0].arrived_at, null); assert.equal(c.svc.db.loads[0].status, 'dispatched');
  const legacy = ctx('driver', DRIVER, [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')].map(({ arrived_at, arrived_by, ...x }) => x));
  r = await stopCall(legacy, S1, { action: 'arrive' }); assert.equal(r.status, 409); assert.equal(r.j.arrivalSetupNeeded, true);
  r = await stopCall(legacy, S1, { action: 'done' }); assert.equal(r.status, 200); assert.equal(r.j.status, 'in_transit');
});

test('delay rules: reason required, note required for Other, start defaults to now, limits, end after start', () => {
  assert.equal(DELAY_REASONS.length, 7);
  assert.ok(cleanDelay({}, NOWISO).error);
  assert.match(cleanDelay({ reason: 'other' }, NOWISO).error, /note/);
  assert.deepEqual(cleanDelay({ reason: 'weather' }, NOWISO).row, { reason: 'weather', note: null, started_at: NOWISO, ended_at: null });
  assert.equal(cleanDelay({ reason: 'other', note: ' lumper late ' }, NOWISO).row.note, 'lumper late');
  assert.match(cleanDelay({ reason: 'traffic', started_at: '2026-10-20T21:00:00Z' }, NOWISO).error, /Start/);
  assert.match(cleanDelay({ reason: 'traffic', started_at: '2026-10-20T18:00:00Z', ended_at: '2026-10-20T17:00:00Z' }, NOWISO).error, /before the start/);
  assert.equal(delayMinutes(cleanDelay({ reason: 'traffic', started_at: '2026-10-20T18:00:00Z', ended_at: '2026-10-20T19:15:00Z' }, NOWISO).row), 75);
  assert.ok(isMissingTable({ code: '42P01' }));
});

test('delays route: add several, edit, delete; other driver 404; missing table → setupNeeded', async () => {
  const c = ctx('driver', DRIVER, [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')]);
  const go = async (m, b, cc = c) => { const r = await DELAYS[m](rq(m === 'GET' ? 'GET' : m, b), { params: { id: L1 }, deps: cc.deps }); return { status: r.status, j: await r.json() }; };
  let r = await go('POST', { stop_id: S1, reason: 'waiting_to_load', started_at: '2026-10-20T18:00:00Z' }); assert.equal(r.status, 200);
  const id = r.j.delay.id;
  r = await go('POST', { stop_id: S1, reason: 'other' }); assert.equal(r.status, 422);
  r = await go('POST', { stop_id: S1, reason: 'breakdown', note: 'TEST flat' }); assert.equal(r.status, 200);
  r = await go('POST', { stop_id: '00000000-0000-4000-8000-0000000000dd', reason: 'weather' }); assert.equal(r.status, 404);
  r = await go('PATCH', { id, ended_at: '2026-10-20T19:00:00Z' }); assert.equal(r.status, 200); assert.equal(r.j.delay.ended_at, '2026-10-20T19:00:00.000Z'); assert.equal(r.j.delay.reason, 'waiting_to_load');
  r = await go('PATCH', { id, ended_at: '2026-10-20T17:00:00Z' }); assert.equal(r.status, 422);
  r = await go('GET'); assert.equal(r.j.delays.length, 2);
  r = await go('DELETE', { id }); assert.equal(r.status, 200);
  r = await go('GET'); assert.equal(r.j.delays.length, 1);
  r = await go('GET', null, ctx('driver', DRIVER2, [stop(S1, 1, 'pickup')])); assert.equal(r.status, 404);
  r = await go('GET', null, ctx('owner', OWNER, [stop(S1, 1, 'pickup')], { noDelays: true })); assert.equal(r.status, 409); assert.equal(r.j.setupNeeded, true);
});

test('Stop times sheet: Arrived, Picked up / Delivered, time on site, delays', async () => {
  const st = [stop(S1, 1, 'pickup', { arrived_at: '2026-10-20T16:00:00Z', completed_at: '2026-10-20T18:15:00Z', completion: 'done' }), stop(S2, 2, 'delivery')];
  const delays = [{ id: 'x', stop_id: S1, reason: 'waiting_to_load', note: 'TEST dock busy', started_at: '2026-10-20T16:10:00Z', ended_at: '2026-10-20T18:00:00Z' }];
  const rows = stopTimeRows({ stops: st }, { delays });
  assert.match(rows[0].arrived, /11:00\s?AM CDT/); assert.match(rows[0].actual, /1:15\s?PM CDT/); assert.equal(rows[0].onSite, '2 h 15 min');
  assert.deepEqual(rows[0].delays.map((d) => [d.reason, d.length, d.note]), [['Waiting to load', '1 h 50 min', 'TEST dock busy']]);
  assert.equal(rows[1].arrived, 'Not recorded'); assert.equal(rows[1].onSite, null);
  assert.equal(stopTimeRows({ stops: [{ id: 'a', stop_type: 'pickup', completed_at: null }] })[0].arrived, null, 'no arrived line before the migration');
  const pdf = await PDFDocument.load(await stopTimesPdf({ broker_load_number: 'TEST-3001', stops: st }, null, { delays }));
  assert.equal(pdf.getPageCount(), 1);
});

test('UI wiring and migration', () => {
  const a = read('../../app/components/StopActions.js');
  assert.match(a, /data-testid="stop-arrive"/); assert.match(a, /data-testid="stop-undo-arrive"/); assert.match(a, /field \}\)\)/); assert.match(a, /<StopDelays supabase=\{supabase\} load=\{load\} \/>/);
  const d = read('../../app/components/StopDelays.js');
  assert.match(d, /stop-delay-add/); assert.match(d, /stop-delay-delete/); assert.match(d, /'PATCH'/);
  const m = read('../../supabase/migrations/20261022170000_stop_arrived_delays.sql');
  for (const re of [/add column if not exists arrived_at timestamptz/, /add column if not exists arrived_by uuid/, /create table if not exists public\.stop_delays/,
    /alter table public\.stop_delays enable row level security/, /packet_role\(l\.user_id\) in \('owner', 'management', 'dispatcher'\)/, /assigned_driver_user_id = auth\.uid\(\)/,
    /stop_delays_other_note/, /to_regprocedure\('public\.email_doc_company\(uuid, uuid\)'\) is not null/]) assert.match(m, re);
});
