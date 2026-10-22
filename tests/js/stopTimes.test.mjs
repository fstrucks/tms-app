// Adjustable stop times + "Stop times" sheet + optional packet attachment (Oct 22). Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fakeSupabase } from './fakeSupabase.mjs';
import { planStopAction, checkStopTime, toLocalInput, fromLocalInput } from '../../app/lib/stopProgress.js';
import { stopTimeRows, stopTimesPdf, stopTimesFileName, fmtStopTime } from '../../app/lib/stopTimesPdf.js';
import { withStopTimes, bundleFiles } from '../../app/lib/invoiceBundle.js';
import { buildBundlePdf } from '../../app/lib/invoiceBundlePdf.js';
import * as ROUTE from '../../app/api/loads/[id]/stops/[stopId]/route.js';
import * as SHEET from '../../app/api/loads/[id]/stop-times/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', DRIVER2 = '00000000-0000-4000-8000-0000000000a3';
const L1 = '00000000-0000-4000-8000-0000000000b1', S1 = '00000000-0000-4000-8000-0000000000d1', S2 = '00000000-0000-4000-8000-0000000000d2';
const NOW = Date.parse('2026-10-20T20:00:00Z'), NOWISO = new Date(NOW).toISOString();
const stop = (id, seq, type, extra = {}) => ({ id, load_id: L1, sequence: seq, stop_type: type, company_name: `TEST ${type} co`, address_line1: '100 Test St', city: 'Dallas', state: 'TX', zip: '75201',
  timezone: 'America/Chicago', appointment_start: '2026-10-20T14:00:00Z', completed_at: null, completion: null, completed_by: null, ...extra });

test('rules: actual time defaults to now, may be adjusted, bounds checked; set_time edits a marked stop only', () => {
  const load = { status: 'dispatched', stops: [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')] };
  assert.equal(planStopAction(load, S1, 'done', { now: NOWISO }).stopPatch.completed_at, NOWISO);
  const at = '2026-10-20T17:15:00.000Z';
  const p = planStopAction(load, S1, 'done', { now: NOWISO, at });
  assert.equal(p.stopPatch.completed_at, at); assert.equal(p.status, 'in_transit');
  assert.equal(planStopAction(load, S1, 'done', { now: NOWISO, at: '2026-10-20T21:00:00Z' }).code, 422, 'future');
  assert.equal(planStopAction(load, S1, 'done', { now: NOWISO, at: '2026-09-01T00:00:00Z' }).code, 422, '>30 days');
  assert.equal(planStopAction(load, S1, 'done', { now: NOWISO, at: 'garbage' }).code, 422);
  assert.equal(planStopAction(load, S1, 'set_time', { now: NOWISO, at }).code, 409, 'not marked yet');
  const marked = { status: 'in_transit', stops: [{ ...load.stops[0], completed_at: NOWISO, completion: 'done', completed_by: DRIVER }, load.stops[1]] };
  const e = planStopAction(marked, S1, 'set_time', { now: NOWISO, at, userId: OWNER });
  assert.deepEqual(e.stopPatch, { completed_at: at, completion: 'done', completed_by: DRIVER }); assert.equal(e.status, null);
  assert.ok(checkStopTime(new Date(NOW + 5 * 60e3).toISOString(), NOWISO).at, '5 min clock drift ok');
  assert.equal(fromLocalInput(toLocalInput(at)), at); assert.equal(fromLocalInput(''), null);
});

function ctx(role, userId, stops) {
  const svc = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, status: 'dispatched', broker_load_number: 'TEST-2001', broker_name: 'Fake Broker', assigned_driver_user_id: DRIVER }], stops,
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }] } });
  const from = svc.from.bind(svc);
  svc.from = (t) => { const q = from(t); if (t === 'loads') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data) r.data = { ...r.data, stops: svc.db.stops.filter((s) => s.load_id === r.data.id) }; return r; }; } return q; };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  const rpc = uc.rpc.bind(uc); uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === OWNER ? role : null, error: null }) : rpc(fn, a));
  return { svc, deps: { mkUserClient: () => uc, sb: svc, now: () => NOW } };
}
const call = async (c, stopId, body) => { const r = await ROUTE.POST(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: { id: L1, stopId }, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('route: driver marks pickup at an adjusted time, then corrects it; bad time 422', async () => {
  const c = ctx('driver', DRIVER, [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery')]);
  let r = await call(c, S1, { action: 'done', at: '2026-10-20T18:30:00Z' });
  assert.equal(r.status, 200); assert.equal(Date.parse(r.j.stop.completed_at), Date.parse('2026-10-20T18:30:00Z')); assert.equal(r.j.status, 'in_transit');
  r = await call(c, S1, { action: 'set_time', at: '2026-10-20T18:05:00Z' });
  assert.equal(r.status, 200); assert.equal(Date.parse(c.svc.db.stops[0].completed_at), Date.parse('2026-10-20T18:05:00Z')); assert.equal(c.svc.db.loads[0].status, 'in_transit');
  r = await call(c, S1, { action: 'set_time', at: '2026-10-21T18:05:00Z' }); assert.equal(r.status, 422);
  r = await call(c, S2, { action: 'set_time', at: '2026-10-20T18:05:00Z' }); assert.equal(r.status, 409);
  r = await call(ctx('driver', DRIVER2, [stop(S1, 1, 'pickup')]), S1, { action: 'set_time', at: '2026-10-20T18:05:00Z' }); assert.equal(r.status, 404);
});

test('sheet rows: address, appointment and actual time in the stop time zone; skipped / not recorded', () => {
  const rows = stopTimeRows({ stops: [stop(S2, 2, 'delivery', { completion: 'skipped', completed_at: NOWISO }), stop(S1, 1, 'pickup', { completed_at: '2026-10-20T18:05:00Z', completion: 'done' }), stop('x', 3, 'delivery', { timezone: null })] }, { tz: 'America/Denver' });
  assert.deepEqual(rows.map((r) => r.type), ['Pickup', 'Delivery', 'Delivery']);
  assert.equal(rows[0].address, '100 Test St, Dallas, TX 75201'); assert.equal(rows[0].actualLabel, 'Picked up');
  assert.match(rows[0].actual, /Oct 20, 2026.*1:05\s?PM CDT/);
  assert.equal(rows[1].actual, 'Skipped'); assert.equal(rows[2].actual, 'Not recorded');
  assert.match(fmtStopTime('2026-10-20T18:05:00Z', 'America/Denver'), /12:05\s?PM MDT/);
  assert.equal(stopTimesFileName({ broker_load_number: 'TEST-2001' }), 'TEST-2001_StopTimes.pdf');
});

test('sheet PDF + route: owner and assigned driver download; other driver 404', async () => {
  const st = [stop(S1, 1, 'pickup', { completed_at: '2026-10-20T18:05:00Z', completion: 'done' }), stop(S2, 2, 'delivery')];
  const pdf = await PDFDocument.load(await stopTimesPdf({ broker_load_number: 'TEST-2001', stops: st }, { legal_name: 'FAKE Trucking LLC' }));
  assert.equal(pdf.getPageCount(), 1); assert.match(pdf.getTitle(), /TEST-2001/);
  const get = (c) => SHEET.GET(new Request('http://x/?tz=America/Chicago', { headers: { authorization: 'Bearer t' } }), { params: { id: L1 }, deps: c.deps });
  for (const [role, u] of [['owner', OWNER], ['driver', DRIVER]]) {
    const r = await get(ctx(role, u, st)); assert.equal(r.status, 200, role);
    assert.match(r.headers.get('content-disposition'), /TEST-2001_StopTimes\.pdf/);
  }
  assert.equal((await get(ctx('driver', DRIVER2, st))).status, 404);
});

test('packet: Stop times sheet only when ticked, before the NOA, merged into the packet', async () => {
  const inv = { load_id: L1, invoice_number: 'INV-1001', load_ref: { load_number: 'TEST-2001' } };
  const files = bundleFiles(inv, [{ id: 'n', doc_type: 'noa', file_path: 'a/noa.pdf' }, { id: 'p', doc_type: 'pod', file_path: 'a/pod.pdf' }]);
  assert.equal(withStopTimes(files, inv, false), files);
  assert.deepEqual(withStopTimes(files, inv, true).map((f) => f.name), ['TEST-2001_Invoice.pdf', 'TEST-2001_POD.pdf', 'TEST-2001_StopTimes.pdf', 'TEST-2001_NOA.pdf']);
  assert.equal(withStopTimes(files, { ...inv, load_id: null }, true), files);
  const one = await PDFDocument.create(); one.addPage(); const invBytes = await one.save();
  const sheet = await stopTimesPdf({ stops: [stop(S1, 1, 'pickup')] });
  const r = await buildBundlePdf(invBytes, [{ kind: 'stop_times', name: 'x', supported: true, pdfBytes: sheet }], async () => null);
  assert.equal((await PDFDocument.load(r.bytes)).getPageCount(), 2); assert.deepEqual(r.skipped, []);
});

test('UI wiring: time picker on confirm, Adjust stop times, load-page download, packet checkbox off by default', () => {
  const a = read('../../app/components/StopActions.js');
  assert.match(a, /type="datetime-local" data-testid="stop-time"/); assert.match(a, /Adjust stop times/); assert.match(a, /'set_time'/);
  assert.match(read('../../app/loads/[id]/page.js'), /<StopTimesDownload supabase=\{supabase\} load=\{load\} \/>/);
  const b = read('../../app/components/InvoiceBundle.js');
  assert.match(b, /useState\(false\); \/\/ attach the Stop times sheet/); assert.match(b, /data-testid="bundle-stop-times"/); assert.match(b, /&stopTimes=1/);
  assert.match(read('../../app/api/invoices/[id]/bundle/route.js'), /sp\.get\('stopTimes'\) === '1'/);
});
