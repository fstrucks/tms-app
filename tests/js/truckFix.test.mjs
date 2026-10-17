// PR #69 QA fixes: A rate con weight → loads.weight → ticket warning; B 409 second driver;
// C service-key path (dispatcher/driver) only ever touches the owner's rows; D Stats label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { parseWeightLb, extractedWeightLb } from '../../app/lib/loadWeight.js';
import { weightChecks } from '../../app/lib/truckFields.js';
import * as TRUCK from '../../app/api/truck/route.js';
import * as TICKETS from '../../app/api/truck/scale-tickets/route.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa', OTHER = '00000000-0000-4000-8000-00000000cccc';
const DISPATCH = '00000000-0000-4000-8000-00000000dddd', DRIVER = '00000000-0000-4000-8000-00000000bbbb';
const T1 = '00000000-0000-4000-8000-0000000000a1', TR1 = '00000000-0000-4000-8000-0000000000b1';
const L_SFB = '00000000-0000-4000-8000-0000000000c5';
const X_TRUCK = '00000000-0000-4000-8000-0000000009a1', X_LOAD = '00000000-0000-4000-8000-0000000009c1';
const X_TICKET = '00000000-0000-4000-8000-0000000009f1', X_DOC = '00000000-0000-4000-8000-0000000009d1', X_DRIVER = '00000000-0000-4000-8000-0000000009e1';
const OWNER_TABLES = ['trucks', 'trailers', 'drivers', 'scale_tickets', 'loads', 'documents'];
const seed = () => ({
  trucks: [{ id: T1, user_id: OWNER, unit_number: '104', empty_weight_lb: 19850, current_trailer_id: TR1 },
    { id: X_TRUCK, user_id: OTHER, unit_number: 'X-1', empty_weight_lb: 1 }],
  trailers: [{ id: TR1, user_id: OWNER, unit_number: 'T-22', empty_weight_lb: 14600 }],
  drivers: [{ id: X_DRIVER, user_id: OTHER, name: 'Other (FAKE)', truck_id: X_TRUCK, active: true }],
  scale_tickets: [{ id: X_TICKET, user_id: OTHER, truck_id: X_TRUCK, ticket_date: '2026-10-10', gross_weight_lb: 50000, confirmed: true }],
  loads: [{ id: L_SFB, user_id: OWNER, broker_load_number: 'SFB-100245', weight: 38500, created_at: '2026-10-17T00:00:00Z' },
    { id: X_LOAD, user_id: OTHER, broker_load_number: 'OTHER-1', weight: 1000, created_at: '2026-10-17T01:00:00Z' }],
  documents: [{ id: X_DOC, user_id: OTHER, file_path: `${OTHER}/x.jpg` }],
});
const UNIQUE = { drivers: [{ cols: ['truck_id'], where: (r) => r.active && r.truck_id }], scale_tickets: [{ cols: ['document_id'] }] };
const req = (method, body) => new Request('http://x/api/truck', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

// Member setup: the caller's own client sees only company_profiles; data lives behind the service client.
function member(role, userId) {
  const svc = fakeSupabase({ tables: seed(), unique: UNIQUE, files: { [`${OTHER}/x.jpg`]: 'x' } });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { svc, uc, deps: { mkUserClient: () => uc, sb: svc, env: { OPENAI_API_KEY: 'k' }, runExtraction: async () => ({ data: { is_scale_ticket: true, gross_weight_lb: 70000, ticket_date: '2026-10-17' } }) } };
}
// Every service-client query on an owner table must be scoped to the owner (user_id = OWNER), and inserts must write OWNER.
function assertOwnerScoped(svc) {
  const qs = svc.calls.filter((c) => OWNER_TABLES.includes(c.t));
  assert.ok(qs.length > 0);
  for (const c of qs) {
    if (c.op === 'insert') { for (const r of [].concat(c.payload)) assert.equal(r.user_id, OWNER, `${c.t} insert writes owner`); continue; }
    const byEq = c.eqs.some(([k, v]) => k === 'user_id' && v === OWNER);
    const byIn = c.ins.some(([k, vs]) => k === 'user_id' && vs.every((v) => v === OWNER || v === DISPATCH));
    assert.ok(byEq || byIn, `${c.op} ${c.t} is scoped to the owner: ${JSON.stringify(c.eqs)} ${JSON.stringify(c.ins)}`);
    if (c.op === 'update') assert.ok(!('user_id' in (c.payload || {})), 'updates never move rows to another owner');
  }
}

// ---------- A ----------
test('A: rate con weight text → whole pounds (numbers, commas, units, k, kg)', () => {
  assert.equal(parseWeightLb(38500), 38500);
  assert.equal(parseWeightLb('38,500 lbs'), 38500);
  assert.equal(parseWeightLb('Weight: 38,500 LB'), 38500);
  assert.equal(parseWeightLb('38500'), 38500);
  assert.equal(parseWeightLb('38.5k lbs'), 38500);
  assert.equal(parseWeightLb('17,463 kg'), 38499);
  assert.equal(parseWeightLb(''), null); assert.equal(parseWeightLb('TBD'), null); assert.equal(parseWeightLb('0 lb'), null); assert.equal(parseWeightLb('900000'), null);
  assert.equal(extractedWeightLb({ weight: '38,500 lbs', weight_lb: 38500 }), 38500);
  assert.equal(extractedWeightLb({ weight: '38,500 lbs' }), 38500); // older reads without weight_lb
  assert.equal(extractedWeightLb({}), null);
});

test('A: the rate con reader asks for weight and saves weight_lb; create-load copies it to loads.weight', () => {
  const ex = readFileSync(new URL('../../app/api/extract/route.js', import.meta.url), 'utf8');
  assert.match(ex, /'equipment_type', 'weight', 'notes'\]/);
  assert.match(ex, /weight: \{ \.\.\.str, description: 'Total cargo\/load weight exactly as printed/);
  assert.match(ex, /extracted = \{ \.\.\.loadData, weight_lb: parseWeightLb\(loadData\.weight\) \}/);
  const docs = readFileSync(new URL('../../app/documents/page.js', import.meta.url), 'utf8');
  const fn = docs.slice(docs.indexOf('async function createLoad'), docs.indexOf("router.push(`/loads/${loadId}`)"));
  assert.match(fn, /const wt = extractedWeightLb\(doc\.ai_extracted_data\);/);
  assert.match(fn, /\.from\('loads'\)\.update\(\{ weight: wt \}\)\.eq\('id', loadId\)\.is\('weight', null\)/);
  const loadPage = readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8');
  assert.match(loadPage, /\['Weight', load\.weight != null \? fmtNumber\(load\.weight, ' lb'\) : null\]/);
  assert.match(loadPage, /\.from\('loads'\)\.update\(\{ weight \}\)\.eq\('id', id\)/);
  // No SQL needed: loads.weight already exists and is in the authenticated update grant.
  assert.match(readFileSync(new URL('../../supabase/migrations/20261010000600_mileage.sql', import.meta.url), 'utf8'), /grant update \([^)]*\bweight\b/);
});

test('A: Taylor\'s case: RC-01 38,500 lb on SFB-100245, ticket net 45,320 → 18% over warning (number or text weight)', () => {
  // gross 79,770 − 19,850 − 14,600 = 45,320 net
  for (const lw of [38500, '38500', '38,500 lb']) {
    const r = weightChecks({ ticket: { gross_weight_lb: 79770 }, truckEmpty: 19850, trailerEmpty: 14600, loadWeight: lw });
    assert.equal(r.net, 45320);
    assert.deepEqual(r.warnings.map((w) => w.code), ['load_mismatch']);
    assert.match(r.warnings[0].text, /Net cargo 45,320 lb is 18% over the rate con weight \(38,500 lb\)/);
  }
  assert.deepEqual(weightChecks({ ticket: { gross_weight_lb: 79770 }, truckEmpty: 19850, trailerEmpty: 14600, loadWeight: null }).warnings, []);
});

test('A: route end-to-end: confirming a ticket linked to SFB-100245 returns the warning on that ticket', async () => {
  const tables = seed(); tables.loads[0].weight = '38,500 lb'; // even if a weight arrived as text
  const own = fakeSupabase({ tables: { ...tables, company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: OWNER }, role: 'owner', unique: UNIQUE });
  const deps = { mkUserClient: () => own };
  const r = await TICKETS.POST(req('POST', { action: 'add', truckId: T1, loadId: L_SFB, values: { ticket_date: '2026-10-17', gross_weight_lb: 79770 } }), { deps });
  const j = await r.json();
  const t = j.tickets.find((x) => x.load_id === L_SFB);
  assert.equal(t.load.broker_load_number, 'SFB-100245');
  assert.equal(t.net, 45320);
  assert.ok(t.warnings.some((w) => w.code === 'load_mismatch'));
});

// ---------- B ----------
test('B: server returns 409 when a second active driver is added to a truck', async () => {
  const tables = seed();
  tables.drivers.push({ id: '00000000-0000-4000-8000-0000000000e1', user_id: OWNER, name: 'Pat Driver (FAKE)', truck_id: T1, active: true });
  const own = fakeSupabase({ tables: { ...tables, company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: OWNER }, role: 'owner', unique: UNIQUE });
  const r = await TRUCK.POST(req('POST', { action: 'save_driver', truckId: T1, values: { driver_name: 'Second Driver (FAKE)' } }), { deps: { mkUserClient: () => own } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /already has a driver/);
  assert.equal(own.db.drivers.filter((d) => d.truck_id === T1 && d.active).length, 1);
  // Even if the pre-check were skipped, the unique index (23505) maps to 409 too.
  const raced = fakeSupabase({ tables: { ...tables, company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: OWNER }, role: 'owner', unique: UNIQUE });
  const orig = raced.from; let n = 0;
  raced.from = (t) => { const q = orig(t); if (t === 'drivers' && n++ === 0) { q.then = (res) => Promise.resolve({ data: [], error: null }).then(res); } return q; };
  assert.equal((await TRUCK.POST(req('POST', { action: 'save_driver', truckId: T1, values: { driver_name: 'Racer (FAKE)' } }), { deps: { mkUserClient: () => raced } })).status, 409);
});

// ---------- C ----------
test('C: dispatcher (service key) reads only the owner\'s rows', async () => {
  const { svc, uc, deps } = member('dispatcher', DISPATCH);
  const j = await (await TRUCK.GET(req('GET'), { deps })).json();
  assert.equal(j.truck.id, T1); assert.equal(j.canEdit, true);
  assert.deepEqual(j.trucks.map((t) => t.id), [T1]);
  assert.ok(j.loads.every((l) => l.id !== X_LOAD));
  assertOwnerScoped(svc);
  assert.deepEqual([...new Set(uc.calls.map((c) => c.t))], ['company_profiles']); // own token never queries owner data
});

test('C: dispatcher writes go only to the owner\'s rows; cross-owner IDs are rejected', async () => {
  const { svc, deps } = member('dispatcher', DISPATCH);
  const before = JSON.stringify({ t: svc.db.trucks.find((t) => t.id === X_TRUCK), k: svc.db.scale_tickets, d: svc.db.drivers });
  // allowed writes, all scoped
  assert.equal((await TRUCK.POST(req('POST', { action: 'save_truck', id: T1, values: { truck_number: '104', truck_plate: 'D104' } }), { deps })).status, 200);
  assert.equal((await TRUCK.POST(req('POST', { action: 'save_driver', truckId: T1, values: { driver_name: 'Pat (FAKE)' } }), { deps })).status, 200);
  assert.equal((await TICKETS.POST(req('POST', { action: 'add', truckId: T1, loadId: L_SFB, values: { ticket_date: '2026-10-17', gross_weight_lb: 70000 } }), { deps })).status, 200);
  // cross-owner IDs → 404, nothing changes
  const cross = [
    [TRUCK, { action: 'save_truck', id: X_TRUCK, values: { truck_number: 'HACK' } }],
    [TRUCK, { action: 'save_driver', truckId: X_TRUCK, values: { driver_name: 'Hack' } }],
    [TRUCK, { action: 'save_driver', truckId: T1, id: X_DRIVER, values: { driver_name: 'Hack' } }],
    [TICKETS, { action: 'add', truckId: X_TRUCK, values: { ticket_date: '2026-10-17', gross_weight_lb: 70000 } }],
    [TICKETS, { action: 'add', truckId: T1, loadId: X_LOAD, values: { ticket_date: '2026-10-17', gross_weight_lb: 70000 } }],
    [TICKETS, { action: 'add', truckId: T1, documentId: X_DOC, values: { ticket_date: '2026-10-17', gross_weight_lb: 70000 } }],
    [TICKETS, { action: 'scan', truckId: T1, documentId: X_DOC }],
    [TICKETS, { action: 'confirm', truckId: T1, id: X_TICKET, values: { ticket_date: '2026-10-17', gross_weight_lb: 70000 } }],
    [TICKETS, { action: 'delete', truckId: T1, id: X_TICKET }],
  ];
  for (const [mod, body] of cross) {
    const r = await mod.POST(req('POST', body), { deps });
    assert.ok([404, 409].includes(r.status), `${body.action} with a foreign id → ${r.status}`);
  }
  assert.equal(JSON.stringify({ t: svc.db.trucks.find((t) => t.id === X_TRUCK), k: svc.db.scale_tickets.filter((t) => t.user_id === OTHER), d: svc.db.drivers.filter((d) => d.user_id === OTHER) }), before);
  assert.ok(svc.db.scale_tickets.filter((t) => t.user_id === OWNER).every((t) => t.truck_id === T1));
  assertOwnerScoped(svc);
});

test('C: driver (service key) gets a read-only view scoped to the owner, and every write is 403 with no DB write', async () => {
  const { svc, deps } = member('driver', DRIVER);
  const j = await (await TRUCK.GET(req('GET'), { deps })).json();
  assert.equal(j.canEdit, false); assert.equal(j.truck.id, T1);
  assertOwnerScoped(svc);
  const n = svc.calls.length;
  for (const [mod, body] of [[TRUCK, { action: 'save_truck', id: T1, values: { truck_number: '1' } }], [TRUCK, { action: 'save_trailer', truckId: T1, values: { trailer_number: 'T' } }],
    [TRUCK, { action: 'save_driver', truckId: T1, values: { driver_name: 'X' } }], [TICKETS, { action: 'add', truckId: T1, values: { ticket_date: '2026-10-17', gross_weight_lb: 70000 } }],
    [TICKETS, { action: 'scan', truckId: T1, documentId: X_DOC }], [TICKETS, { action: 'delete', truckId: T1, id: X_TICKET }]]) {
    assert.equal((await mod.POST(req('POST', body), { deps })).status, 403);
  }
  assert.equal(svc.calls.length, n, 'a driver write never reaches the database');
});

test('C: without a service key, team members get 503 (never fall back to unscoped access)', async () => {
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: DISPATCH }, role: 'dispatcher' });
  const r = await TRUCK.GET(req('GET'), { deps: { mkUserClient: () => uc, mkService: () => null } });
  assert.equal(r.status, 503);
});

// ---------- D ----------
test('D: desktop nav says Stats (matches mobile)', () => {
  const nav = readFileSync(new URL('../../app/components/AppNav.js', import.meta.url), 'utf8');
  assert.match(nav, /\{ href: '\/dashboard', label: 'Stats', icon:/);
  assert.doesNotMatch(nav, /label: 'Dashboard'/);
});
