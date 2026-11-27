// Multi-stop rate cons (Nov 27): every stop on the rate con reaches the load, not just the first pickup and the last
// delivery. Fake data only; no network, no model calls. The SQL itself is tested in tests/sql/multistop_ratecon.pglite.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRateConStops, cleanRateConStop, stopsListValid, stopsFromTopLevel, rateConStops, rateConStopCount, stopsFoundLabel,
  stopWhenLine, stopsNote, MAX_RATECON_STOPS } from '../../app/lib/rateconStops.js';
import { schema, PROMPT, callRateConModel } from '../../app/lib/rateconExtract.js';
import { multiStopReady, MULTISTOP_RPC } from '../../app/lib/rateconDrafts.js';
import { planRescan, rescanScan, targetStops } from '../../app/lib/rateconRescan.js';

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const S = (type, name, extra = {}) => ({ type, name, address: null, street: null, city: null, state: null, zip: null, date: null, time: null, ref_number: null, ...extra });
const top = {
  broker_name: 'FAKE Broker', reference_numbers: [],
  shipper: { name: 'FAKE Shipper A', address: '100 Test Rd, Lathrop, CA 95330' }, receiver: { name: 'FAKE Receiver C', address: '9 Main St, Hillsboro, OR 97124' },
  pickup: { date: '2026-11-30', time: '08:00', address: null, street: null, city: null, state: null, zip: null, pickup_number: 'PU# 111' },
  delivery: { date: '2026-12-02', time: null, address: null, street: null, city: null, state: null, zip: null, pickup_number: null },
};
const three = [
  S('pickup', 'FAKE Shipper A', { street: '100 Test Rd', city: 'Lathrop', state: 'CA', zip: '95330', date: '2026-11-30', time: '08:00', ref_number: 'PU# 111' }),
  S('delivery', 'FAKE Middle B', { address: '55 Dock Ave, Warrenton, OR 97146', date: '2026-12-01', ref_number: 'D-22' }),
  S('delivery', 'FAKE Receiver C', { address: '9 Main St, Hillsboro, OR 97124', date: '2026-12-02' }),
];

test('schema: ordered stops[] with type / facility / address parts / date / time / ref, strict', () => {
  const p = schema.properties.stops;
  assert.deepEqual(p.type, ['array', 'null']);
  const it = p.items;
  assert.equal(it.additionalProperties, false);
  for (const k of ['type', 'name', 'address', 'street', 'city', 'state', 'zip', 'date', 'time', 'ref_number']) {
    assert.ok(it.properties[k], k); assert.ok(it.required.includes(k), `${k} required`);
  }
  assert.deepEqual(it.properties.type.enum, ['pickup', 'delivery']);
  assert.ok(schema.required.includes('stops'));
  assert.match(p.description, /at most 20/);
  // Top-level fields stay for backward compatibility.
  for (const k of ['shipper', 'receiver', 'pickup', 'delivery']) assert.ok(schema.required.includes(k), k);
});

test('prompt: list every stop in order, max 20; pickup / delivery stay the first pickup and last delivery', () => {
  assert.match(PROMPT, /list EVERY stop in route order in stops, at most 20/);
  assert.match(PROMPT, /do not skip middle stops/);
  assert.match(PROMPT, /pickup and shipper are the FIRST pickup; delivery and receiver are the LAST delivery/);
});

test('model call: room for 20 stops (max_output_tokens), stops in the strict schema sent', async () => {
  let sent;
  const fetchImpl = async (_u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ output_text: '{"stops":[]}' }) }; };
  const r = await callRateConModel({ apiKey: 'fake', model: 'gpt-4o-mini', mime: 'application/pdf', name: 'x.pdf', bytes: Buffer.from('x'), fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(sent.max_output_tokens >= 4000);
  assert.ok(sent.text.format.schema.properties.stops);
});

test('normalize: a 3-stop list is kept in order, cleaned, addresses composed, PU label stripped', () => {
  const x = normalizeRateConStops({ ...top, stops: three });
  assert.equal(x.stops.length, 3);
  assert.deepEqual(x.stops.map((s) => [s.type, s.name]), [['pickup', 'FAKE Shipper A'], ['delivery', 'FAKE Middle B'], ['delivery', 'FAKE Receiver C']]);
  assert.equal(x.stops[0].address, '100 Test Rd, Lathrop, CA 95330');
  assert.equal(x.stops[0].ref_number, '111');
  assert.equal(x.stops[1].ref_number, 'D-22');
  // Top-level fields the scan filled are left as they were (the old SQL keeps reading them).
  assert.equal(x.shipper.name, 'FAKE Shipper A');
  assert.equal(x.receiver.name, 'FAKE Receiver C');
  assert.equal(x.pickup.pickup_number, '111');
  assert.deepEqual(x.reference_numbers, ['PU# 111']);
  assert.equal('stops_total' in x, false);
});

test('normalize: empty top-level fields are filled from the first pickup and the last delivery', () => {
  const x = normalizeRateConStops({ broker_name: 'FAKE', stops: [three[0], S('pickup', 'FAKE P2', { city: 'Stockton', state: 'CA' }), three[1], three[2]] });
  assert.equal(x.shipper.name, 'FAKE Shipper A');
  assert.equal(x.pickup.address, '100 Test Rd, Lathrop, CA 95330');
  assert.equal(x.pickup.pickup_number, '111');
  assert.equal(x.receiver.name, 'FAKE Receiver C');
  assert.equal(x.delivery.address, '9 Main St, Hillsboro, OR 97124');
  assert.equal(x.delivery.date, '2026-12-02');
  assert.equal(x.stops.length, 4);
});

test('normalize: missing / short / invalid stops[] → the 2-stop list from the top-level fields', () => {
  const two = (x) => normalizeRateConStops(x).stops.map((s) => [s.type, s.name, s.address, s.date, s.ref_number]);
  const want = [['pickup', 'FAKE Shipper A', '100 Test Rd, Lathrop, CA 95330', '2026-11-30', '111'], ['delivery', 'FAKE Receiver C', '9 Main St, Hillsboro, OR 97124', '2026-12-02', null]];
  assert.deepEqual(two(top), want); // old scan: no stops[]
  assert.deepEqual(two({ ...top, stops: null }), want);
  assert.deepEqual(two({ ...top, stops: [three[0]] }), want); // fewer than 2
  assert.deepEqual(two({ ...top, stops: [three[0], { ...three[1], type: 'pickup' }] }), want); // no delivery
  assert.deepEqual(two({ ...top, stops: 'three stops' }), want);
  // A bad entry is dropped; what's left still has to be a valid list.
  assert.equal(normalizeRateConStops({ ...top, stops: [three[0], { ...three[1], type: 'fuel' }, three[2]] }).stops.length, 2);
  assert.equal(normalizeRateConStops({ ...top, stops: [three[0], S('delivery', null), three[1], three[2]] }).stops.length, 3);
});

test('normalize: 21+ stops → not used (2 stops), stops_total keeps the count; exactly 20 is kept', () => {
  const many = (n) => [three[0], ...Array.from({ length: n - 2 }, (_, i) => S('delivery', `FAKE D${i}`, { city: 'Reno', state: 'NV' })), three[2]];
  const over = normalizeRateConStops({ ...top, stops: many(23) });
  assert.equal(over.stops.length, 2);
  assert.equal(over.stops_total, 23);
  assert.equal(rateConStopCount(over), 23);
  assert.match(stopsNote(over, true), /lists 23 stops, more than the 20/);
  const twenty = normalizeRateConStops({ ...top, stops: many(MAX_RATECON_STOPS) });
  assert.equal(twenty.stops.length, 20);
  assert.equal('stops_total' in twenty, false);
  // Re-normalizing (re-run extraction) doesn't keep a stale count.
  assert.equal('stops_total' in normalizeRateConStops({ ...over, stops: three }), false);
});

test('normalize is idempotent and leaves non-objects alone', () => {
  const once = normalizeRateConStops({ ...top, stops: three });
  assert.deepEqual(normalizeRateConStops(once), once);
  assert.equal(normalizeRateConStops(null), null);
});

test('cleanRateConStop / stopsListValid / stopsFromTopLevel', () => {
  assert.equal(cleanRateConStop({ type: 'fuel', name: 'X' }), null);
  assert.equal(cleanRateConStop({ type: 'pickup' }), null);
  assert.equal(cleanRateConStop({ type: 'Drop', city: 'Reno' }).type, 'delivery');
  assert.equal(stopsListValid([S('pickup', 'a'), S('delivery', 'b')]), true);
  assert.equal(stopsListValid([S('pickup', 'a'), S('pickup', 'b')]), false);
  assert.equal(stopsListValid(Array.from({ length: 21 }, (_, i) => S(i ? 'delivery' : 'pickup', 'a'))), false);
  assert.deepEqual(stopsFromTopLevel({}), []);
});

test('review helpers: count, label, when line, note before / after the SQL', () => {
  const x = normalizeRateConStops({ ...top, stops: three });
  assert.equal(rateConStopCount(x), 3);
  assert.equal(stopsFoundLabel(3), '3 stops found');
  assert.equal(stopsFoundLabel(1), '1 stop found');
  assert.equal(stopWhenLine(x.stops[1]), '2026-12-01 · Ref D-22');
  assert.equal(stopsNote(x, true), null);
  assert.equal(stopsNote(x, null), null); // unknown: no note
  assert.match(stopsNote(x, false), /first pickup and the last delivery only/);
  assert.equal(stopsNote(normalizeRateConStops(top), false), null); // 2 stops: nothing to warn about
  // Rows saved before this change (no stops[]) still show their 2 stops.
  assert.equal(rateConStops({ shipper: { name: 'A' }, receiver: { name: 'C' } }).length, 2);
  assert.deepEqual(rateConStops(null), []);
});

test('multiStopReady: true when the helper exists, false when missing, null on other errors', async () => {
  const sb = (error) => ({ rpc: async (fn, args) => { assert.equal(fn, MULTISTOP_RPC); assert.deepEqual(args, { p_x: {} }); return { data: [], error }; } });
  assert.equal(await multiStopReady(sb(null)), true);
  assert.equal(await multiStopReady(sb({ code: 'PGRST202' })), false);
  assert.equal(await multiStopReady(sb({ code: '42883' })), false);
  assert.equal(await multiStopReady(sb({ code: '500' })), null);
  assert.equal(await multiStopReady({ rpc: async () => { throw new Error('offline'); } }), null);
});

test('rescan: only the first pickup / last delivery are filled; middle stops are never planned, removed or reordered', () => {
  const stops = [
    { id: 's1', sequence: 1, stop_type: 'pickup', address_line1: '', city: '', state: '', zip: '' },
    { id: 's2', sequence: 2, stop_type: 'delivery', address_line1: '', city: '', state: '', zip: '' },
    { id: 's3', sequence: 3, stop_type: 'pickup', address_line1: '', city: '', state: '', zip: '' },
    { id: 's4', sequence: 4, stop_type: 'delivery', address_line1: '', city: '', state: '', zip: '' },
  ];
  assert.deepEqual([targetStops(stops).pickup.id, targetStops(stops).delivery.id], ['s1', 's4']);
  const scan = rescanScan(normalizeRateConStops({ ...top, pickup: { ...top.pickup, address: '100 Test Rd, Lathrop, CA 95330' }, delivery: { ...top.delivery, address: '9 Main St, Hillsboro, OR 97124' }, stops: three }));
  const ids = new Set(planRescan({ notes: '', stops }, scan).filter((c) => c.stopId).map((c) => c.stopId));
  assert.deepEqual([...ids].sort(), ['s1', 's4']);
  // The route only updates fields of planned stops; it never inserts or deletes stops.
  const route = src('../../app/api/loads/[id]/rescan-ratecon/route.js');
  assert.doesNotMatch(route, /from\('stops'\)\.(delete|insert|upsert)/);
});

test('both scan paths (upload and email) store stops[] through normalizeRateConStops', () => {
  assert.match(src('../../app/api/extract/route.js'), /\.\.\.normalizeRateConStops\(loadData\)/);
  assert.match(src('../../app/lib/rateconEmail.js'), /\.\.\.normalizeRateConStops\(loadData\)/);
});

test('Documents review: "N stops found" + the ordered list for 3+, old rows kept for 2, note before the SQL', () => {
  const page = src('../../app/documents/page.js');
  assert.match(page, /function StopsList\(\{ x, sqlReady \}\)/);
  assert.match(page, /data-testid="ratecon-stops-found"[^>]*>\{stopsFoundLabel\(rateConStopCount\(x\)\)\}/);
  assert.match(page, /stops\.map\(\(st, i\) =>/);
  assert.match(page, /\{i \+ 1\}\. \{stopTypeLabel\(st\.type\)\}/);
  assert.match(page, /data-testid="ratecon-stops-note"/);
  assert.match(page, /const many = rateConStopCount\(x\) >= 3;/);
  assert.match(page, /\['Shipper', fmtParty\(x\.shipper\)\],\s*\['Pickup', fmtStop\(x\.pickup\)\],\s*\['Receiver', fmtParty\(x\.receiver\)\],\s*\['Delivery', fmtStop\(x\.delivery\)\],/);
  assert.match(page, /<Summary x=\{d\.ai_extracted_data\} sqlReady=\{multiStopSql\} \/>/);
  // Checked once, only when a draft with 3+ stops is on screen.
  assert.match(page, /multiStopChecked\.current = true;\s*multiStopReady\(supabase\)\.then\(setMultiStopSql\)/);
  assert.match(page, /rateConStopCount\(d\.ai_extracted_data\) >= 3/);
  // Phone width: the value column can shrink and long names / addresses wrap.
  assert.match(page, /gridTemplateColumns: 'auto minmax\(0, 1fr\)'/);
  assert.match(page, /wordBreak: 'break-word', minWidth: 0/);
});

test('migration 20261127000100: additive, same signatures, helper used by all three create functions', () => {
  const m = src('../../supabase/migrations/20261127000100_multistop_ratecon.sql');
  assert.doesNotMatch(m, /\bdrop\s+(function|table|policy|trigger)/i);
  assert.match(m, /create or replace function public\.ratecon_load_stops\(p_x jsonb\)/);
  assert.match(m, /create or replace function public\.create_load_from_document\(p_document uuid, p_tz text default 'America\/Los_Angeles'\)\nreturns uuid\nlanguage plpgsql\nsecurity invoker\nset search_path = public/);
  assert.match(m, /create or replace function public\.create_load_from_email_document\(p_document uuid, p_tz text default 'America\/Chicago'\)\nreturns uuid\nlanguage plpgsql\nsecurity definer\nset search_path = public/);
  assert.match(m, /create or replace function public\.create_load_from_company_upload\(p_document uuid, p_tz text default 'America\/Los_Angeles', p_profile uuid default null\)\nreturns uuid\nlanguage plpgsql\nsecurity definer\nset search_path = public/);
  assert.equal((m.match(/select \* from public\.ratecon_load_stops\(v_x\) order by seq/g) || []).length, 3);
  assert.match(m, /count\(\*\) between 3 and 20/);
  assert.match(m, /\(values \(1, 'pickup', 'shipper', 'pickup'\), \(2, 'delivery', 'receiver', 'delivery'\)\)/);
});
