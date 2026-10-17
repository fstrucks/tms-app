import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase, fakeId } from './fakeSupabase.mjs';
import { weightChecks, netCargo, canEditTruck, truckInput, trailerInput, driverInput, ticketInput, normalizeScaleTicket } from '../../app/lib/truckFields.js';
import { DOC_TYPES } from '../../app/lib/ai-extract.js';
import { UPLOAD_TYPES, docTypeLabel } from '../../app/lib/docTypes.js';
import { mileageRedirectUrl, MILEAGE_VIEW_URL } from '../../app/lib/statsViews.js';
import * as TRUCK from '../../app/api/truck/route.js';
import * as TICKETS from '../../app/api/truck/scale-tickets/route.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa', DRIVER_USER = '00000000-0000-4000-8000-00000000bbbb';
const T1 = '00000000-0000-4000-8000-0000000000a1', TR1 = '00000000-0000-4000-8000-0000000000b1', L1 = '00000000-0000-4000-8000-0000000000c1', DOC = '00000000-0000-4000-8000-0000000000d1';
const seed = () => ({
  company_profiles: [{ id: 'p1', owner_id: OWNER }],
  trucks: [{ id: T1, user_id: OWNER, unit_number: '104', license_plate: 'TEST104', license_state: 'CA', vin: null, empty_weight_lb: 19850, current_trailer_id: TR1 }],
  trailers: [{ id: TR1, user_id: OWNER, unit_number: 'T-22', license_plate: 'TRL0022', license_state: 'CA', empty_weight_lb: 14600 }],
  drivers: [], scale_tickets: [],
  loads: [{ id: L1, user_id: OWNER, broker_load_number: 'FAKE-1001', broker_name: 'Test Broker LLC (FAKE)', weight: 42000, created_at: '2026-10-16T00:00:00Z' }],
  documents: [{ id: DOC, user_id: OWNER, file_path: `${OWNER}/1-ticket.jpg`, doc_type: 'scale_ticket' }],
});
const UNIQUE = { drivers: [{ cols: ['truck_id'], where: (r) => r.active && r.truck_id }], scale_tickets: [{ cols: ['document_id'] }] };
function setup({ role = 'owner', userId = OWNER, tables = seed(), missing = [] } = {}) {
  const user = fakeSupabase({ tables, user: { id: userId }, role, unique: UNIQUE, missing, files: { [`${OWNER}/1-ticket.jpg`]: 'img' } });
  const svc = userId === OWNER ? null : user; // members read the owner's rows through the service client (same fake DB here)
  const ai = [];
  const deps = { mkUserClient: () => user, sb: svc, mkService: () => svc, env: { OPENAI_API_KEY: 'test-key' },
    runExtraction: async (type) => { ai.push(type); return { data: normalizeScaleTicket({ is_scale_ticket: true, gross_weight_lb: '81,240 LB', steer_axle_lb: 12340, drive_axle_lb: 33800, trailer_axle_lb: 35100, ticket_date: '2026-10-16', scale_name: 'CAT Scale #000 (FAKE)' }) }; } };
  return { user, deps, ai };
}
const req = (method, body, q = '') => new Request(`http://x/api/truck${q}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('net cargo and weight warnings: 80k gross, axles 12k/34k/34k, rate con ±10%', () => {
  assert.equal(netCargo(78420, 19850, 14600), 43970);
  assert.equal(netCargo(78420, 19850, null), null);
  const ok = weightChecks({ ticket: { gross_weight_lb: 78420, steer_axle_lb: 11800, drive_axle_lb: 33000, trailer_axle_lb: 33620 }, truckEmpty: 19850, trailerEmpty: 14600, loadWeight: 42000 });
  assert.equal(ok.net, 43970); assert.deepEqual(ok.warnings, []); // 4.7% off → no flag
  const bad = weightChecks({ ticket: { gross_weight_lb: 81240, steer_axle_lb: 12340, drive_axle_lb: 34100, trailer_axle_lb: 35100 }, truckEmpty: 19850, trailerEmpty: 14600, loadWeight: 42000 });
  assert.deepEqual(bad.warnings.map((w) => w.code), ['gross_over', 'steer_axle_over', 'drive_axle_over', 'trailer_axle_over', 'load_mismatch']);
  assert.match(bad.warnings[0].text, /Gross 81,240 lb is over the 80,000 lb limit \(by 1,240 lb\)/);
  assert.match(bad.warnings[4].text, /Net cargo 46,790 lb is 11% over the rate con weight \(42,000 lb\)/);
  assert.deepEqual(weightChecks({ ticket: { gross_weight_lb: 80000, steer_axle_lb: 12000, drive_axle_lb: 34000, trailer_axle_lb: 34000 } }).warnings, []); // limits are inclusive
  assert.equal(weightChecks({ ticket: { gross_weight_lb: 70000 }, truckEmpty: 19850, trailerEmpty: 14600, loadWeight: 31000 }).warnings[0].code, 'load_mismatch'); // under by >10%
  assert.equal(weightChecks({ ticket: { gross_weight_lb: 30000 }, truckEmpty: 19850, trailerEmpty: 14600 }).warnings[0].code, 'net_negative');
  assert.deepEqual(weightChecks({ ticket: { gross_weight_lb: 34310 }, truckEmpty: 19850, trailerEmpty: 14600 }).warnings, []); // −140 lb: scale variance, no flag
});

test('input cleaning: field keys → columns, states, VIN, weights, dates', () => {
  assert.deepEqual(truckInput({ truck_number: ' 104 ', truck_plate: 'TEST104', truck_plate_state: 'ca', vin: '1fakevxn0test0104', truck_empty_weight_lb: '19,850' }).patch,
    { unit_number: '104', license_plate: 'TEST104', license_state: 'CA', vin: '1FAKEVXN0TEST0104', empty_weight_lb: 19850 });
  assert.match(truckInput({ truck_number: '1', vin: 'SHORT' }).error, /VIN/);
  assert.match(truckInput({}).error, /truck number/);
  assert.match(trailerInput({ trailer_number: 'T', trailer_plate_state: 'Cal' }).error, /2-letter/);
  assert.match(driverInput({ driver_name: 'Pat', cdl_expiry: '2026-02-30' }).error, /valid date/);
  assert.deepEqual(ticketInput({ ticket_date: '2026-10-16', gross_weight_lb: '78,420 lb', steer_axle_lb: '' }).patch, { ticket_date: '2026-10-16', gross_weight_lb: 78420, scale_name: null, steer_axle_lb: null, drive_axle_lb: null, trailer_axle_lb: null });
  assert.match(ticketInput({ ticket_date: '2026-10-16', gross_weight_lb: '12' }).error, /Gross/);
});

test('scale_ticket reader type + doc type exist', () => {
  assert.ok(DOC_TYPES.scale_ticket);
  assert.deepEqual(DOC_TYPES.scale_ticket.normalize({ is_scale_ticket: true, gross_weight_lb: '78,420 LB', ticket_date: '2026-10-16' }).gross_weight_lb, 78420);
  assert.ok(UPLOAD_TYPES.some((t) => t.id === 'scale_ticket'));
  assert.equal(docTypeLabel('scale_ticket'), 'Scale ticket');
});

test('drivers are read-only: canEditTruck and server 403 on every write', async () => {
  assert.equal(canEditTruck('driver'), false);
  for (const r of ['owner', 'dispatcher', 'management']) assert.equal(canEditTruck(r), true);
  const { deps } = setup({ role: 'driver', userId: DRIVER_USER });
  const g = await TRUCK.GET(req('GET'), { deps });
  const j = await g.json();
  assert.equal(g.status, 200); assert.equal(j.canEdit, false); assert.equal(j.truck.unit_number, '104');
  for (const body of [{ action: 'save_truck', values: { truck_number: '9' } }, { action: 'save_driver', truckId: T1, values: { driver_name: 'X' } }]) {
    assert.equal((await TRUCK.POST(req('POST', body), { deps })).status, 403);
  }
  for (const body of [{ action: 'add', truckId: T1, values: { ticket_date: '2026-10-16', gross_weight_lb: 70000 } }, { action: 'scan', truckId: T1, documentId: DOC }]) {
    assert.equal((await TICKETS.POST(req('POST', body), { deps })).status, 403);
  }
});

test('driver sees the truck he drives (drivers.auth_user_id), others default to the first truck', async () => {
  const tables = seed();
  const T2 = fakeId();
  tables.trucks.unshift({ id: T2, user_id: OWNER, unit_number: '099', empty_weight_lb: null });
  tables.drivers.push({ id: fakeId(), user_id: OWNER, name: 'Pat Driver (FAKE)', truck_id: T1, auth_user_id: DRIVER_USER, active: true });
  const { deps } = setup({ role: 'driver', userId: DRIVER_USER, tables });
  assert.equal((await (await TRUCK.GET(req('GET'), { deps })).json()).truck.id, T1);
  const own = setup({ tables: seed() });
  assert.equal((await (await TRUCK.GET(req('GET'), { deps: own.deps })).json()).truck.id, T1);
});

test('owner saves truck, trailer and driver; one active driver per truck (no team drivers)', async () => {
  const { deps, user } = setup();
  let r = await TRUCK.POST(req('POST', { action: 'save_truck', id: T1, values: { truck_number: '104', truck_plate: 'NEW104', truck_plate_state: 'nv', truck_empty_weight_lb: '20000' } }), { deps });
  assert.equal(r.status, 200);
  assert.equal(user.db.trucks[0].license_plate, 'NEW104'); assert.equal(user.db.trucks[0].license_state, 'NV');
  r = await TRUCK.POST(req('POST', { action: 'save_trailer', truckId: T1, values: { trailer_number: 'T-30', trailer_empty_weight_lb: 15000 } }), { deps });
  const j = await r.json();
  assert.equal(j.trailer.unit_number, 'T-30'); assert.equal(user.db.trucks[0].current_trailer_id, j.trailer.id);
  r = await TRUCK.POST(req('POST', { action: 'save_driver', truckId: T1, values: { driver_name: 'Pat Driver (FAKE)', cdl_state: 'ca', cdl_expiry: '2027-03-01' } }), { deps });
  assert.equal((await r.json()).driver.cdl_state, 'CA');
  r = await TRUCK.POST(req('POST', { action: 'save_driver', truckId: T1, values: { driver_name: 'Second (FAKE)' } }), { deps });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /already has a driver/);
  assert.equal(user.db.drivers.length, 1);
  // Another owner's truck id is not found.
  assert.equal((await TRUCK.POST(req('POST', { action: 'save_driver', truckId: fakeId(), values: { driver_name: 'X' } }), { deps })).status, 404);
});

test('scan: AI read → unconfirmed row with warnings; re-scan updates (no duplicate); confirm counts as latest', async () => {
  const { deps, user, ai } = setup();
  let r = await TICKETS.POST(req('POST', { action: 'scan', truckId: T1, documentId: DOC }), { deps });
  let j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(ai, ['scale_ticket']);
  assert.equal(user.db.scale_tickets.length, 1);
  const t = j.tickets[0];
  assert.equal(t.confirmed, false); assert.equal(t.source, 'ai'); assert.equal(t.trailer_id, TR1); assert.equal(t.gross_weight_lb, 81240);
  assert.equal(t.net, 81240 - 19850 - 14600);
  assert.deepEqual(t.warnings.map((w) => w.code), ['gross_over', 'steer_axle_over', 'trailer_axle_over']);
  assert.equal(j.latest, null); // unconfirmed tickets don't count yet
  await TICKETS.POST(req('POST', { action: 'scan', truckId: T1, documentId: DOC }), { deps });
  assert.equal(user.db.scale_tickets.length, 1);
  r = await TICKETS.POST(req('POST', { action: 'confirm', truckId: T1, id: t.id, loadId: L1, values: { ticket_date: '2026-10-16', gross_weight_lb: 81240, steer_axle_lb: 12340, drive_axle_lb: 33800, trailer_axle_lb: 35100 } }), { deps });
  j = await r.json();
  assert.equal(j.latest.gross_weight_lb, 81240);
  assert.ok(j.tickets[0].warnings.some((w) => w.code === 'load_mismatch')); // 46,790 vs 42,000 → 11%
  // A confirmed ticket is never overwritten by a re-scan.
  r = await TICKETS.POST(req('POST', { action: 'scan', truckId: T1, documentId: DOC }), { deps });
  assert.match((await r.json()).note, /already in the history/);
  assert.equal(user.db.scale_tickets[0].confirmed, true);
});

test('manual add, foreign load rejected, delete', async () => {
  const { deps, user } = setup();
  let r = await TICKETS.POST(req('POST', { action: 'add', truckId: T1, values: { ticket_date: '2026-10-09', gross_weight_lb: '71,260' } }), { deps });
  assert.equal(r.status, 200); assert.equal(user.db.scale_tickets[0].source, 'manual'); assert.equal(user.db.scale_tickets[0].confirmed, true);
  assert.equal((await TICKETS.POST(req('POST', { action: 'add', truckId: T1, loadId: fakeId(), values: { ticket_date: '2026-10-09', gross_weight_lb: 70000 } }), { deps })).status, 404);
  r = await TICKETS.POST(req('POST', { action: 'delete', truckId: T1, id: user.db.scale_tickets[0].id }), { deps });
  assert.equal(r.status, 200); assert.equal(user.db.scale_tickets.length, 0);
});

test('migration not applied yet → setupNeeded 503 (no crash)', async () => {
  const { deps } = setup({ missing: ['drivers'] });
  const r = await TRUCK.GET(req('GET'), { deps });
  assert.equal(r.status, 503); assert.equal((await r.json()).setupNeeded, true);
});

test('Mileage lives inside Stats; /mileage redirects keeping params; Truck replaces Mileage in the nav', () => {
  assert.equal(MILEAGE_VIEW_URL, '/dashboard?view=mileage');
  assert.equal(mileageRedirectUrl({ imported: '5', skipped: '1' }), '/dashboard?view=mileage&imported=5&skipped=1');
  assert.equal(mileageRedirectUrl({}), '/dashboard?view=mileage');
  const nav = readFileSync(new URL('../../app/components/AppNav.js', import.meta.url), 'utf8');
  const tabs = [...nav.matchAll(/\{ href: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['/', '/dashboard', '/loads', '/documents', '/expenses', '/truck']);
  assert.match(nav, /p\.startsWith\('\/dashboard'\) \|\| p\.startsWith\('\/mileage'\)/);
  const dash = readFileSync(new URL('../../app/dashboard/page.js', import.meta.url), 'utf8');
  assert.match(dash, /view === 'mileage' \? <MileagePanel \/>/);
  assert.ok(readFileSync(new URL('../../app/mileage/import/page.js', import.meta.url), 'utf8').includes('/dashboard?view=mileage'));
});

test('Truck page: read-only hides every edit control; company is a link only', () => {
  const src = readFileSync(new URL('../../app/truck/page.js', import.meta.url), 'utf8');
  assert.match(src, /const truck = d\?\.truck, trailer = d\?\.trailer, driver = d\?\.driver, ro = d && !d\.canEdit;/);
  for (const label of ['Edit truck', 'Add trailer', 'Edit driver', 'Scan scale ticket', 'Remove']) {
    const i = src.indexOf(label); assert.ok(i > 0, label);
    assert.ok(src.lastIndexOf('!ro', i) > src.lastIndexOf('<section', i), `${label} is behind !ro`);
  }
  assert.match(src, /href="\/company"/);
  assert.doesNotMatch(src, /\b(ifta|irp|ucr|scac)\b/i);
  assert.match(src, /getSupabase\(\)/);
});
