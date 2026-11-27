// Owner's load page: + Add stop (Nov 27, 2026). Logic in app/lib/ownerStops.js + app/lib/dispatch.js (stops form),
// UI in app/components/OwnerStopsEditor.js + StopsEditor.js, wired into app/loads/[id]/page.js. Fake data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canOwnerEditStops, openWithNewStop, removedDoneStops, saveOwnerStops, OWNER_STOPS_SETUP_MSG, MAX_STOPS, MIN_STOPS,
} from '../../app/lib/ownerStops.js';
import { stopsToForm, formToStops, addStop, blankStop, splitDeliveryRef, joinDeliveryRef } from '../../app/lib/dispatch.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const STOPS = [
  { id: 11, sequence: 1, stop_type: 'pickup', company_name: 'Acme Foods (FAKE)', address_line1: '100 Test Way', city: 'Lathrop', state: 'CA', zip: '95330',
    pickup_number: 'PU-777', notes: 'Dock 4', completed_at: '2026-11-27T16:00:00Z', completion: 'done', contact_name: 'Pat (FAKE)', contact_phone: '555-0100' },
  { id: 12, sequence: 2, stop_type: 'delivery', company_name: 'Demo DC (FAKE)', city: 'Hillsboro', state: 'OR', zip: '97124', notes: 'Delivery # PO-55\nCall ahead' },
];
const types = (l) => l.map((x) => x.stop_type).join(',');

test('only the load owner gets the editor (drivers / team viewers never)', () => {
  assert.equal(canOwnerEditStops({ stops: [] }), true);
  assert.equal(canOwnerEditStops({ viewer_role: 'owner', stops: STOPS }), true);
  for (const r of ['driver', 'dispatcher', 'management']) assert.equal(canOwnerEditStops({ viewer_role: r, stops: STOPS }), false, r);
  assert.equal(canOwnerEditStops({ viewer_role: 'owner' }), false, 'stops not loaded yet');
  assert.equal(canOwnerEditStops(null), false);
});

test('+ Add stop opens with a new delivery just before the final delivery; pickups go before the first delivery', () => {
  const l = openWithNewStop(STOPS, 'delivery', 'America/Los_Angeles');
  assert.equal(types(l), 'pickup,delivery,delivery');
  assert.equal(l[1].id, null); assert.equal(l[2].id, 12, 'the final delivery stays last');
  assert.equal(l[1].timezone, 'America/Los_Angeles');
  const p = openWithNewStop(STOPS, 'pickup');
  assert.equal(types(p), 'pickup,pickup,delivery'); assert.equal(p[1].id, null);
  // in the editor: another delivery also lands before the final one, Dispatch keeps appending
  const three = addStop(l, 'delivery', '', { beforeLastDelivery: true });
  assert.equal(three[3].id, 12);
  assert.equal(addStop(l, 'delivery')[3].id, null, 'Dispatch default unchanged: appends');
  assert.equal(types(addStop([blankStop('pickup')], 'delivery', '', { beforeLastDelivery: true })), 'pickup,delivery', 'no delivery yet → append');
});

test('max 20 stops: no new row past the limit; min 2 / pickup + delivery enforced on save', () => {
  assert.equal(MAX_STOPS, 20); assert.equal(MIN_STOPS, 2);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, sequence: i + 1, stop_type: i === 19 ? 'delivery' : 'pickup', city: 'Fakeville', state: 'CA' }));
  assert.equal(openWithNewStop(many).length, 20);
  assert.equal(addStop(stopsToForm(many), 'pickup').length, 20);
  const form = stopsToForm(STOPS);
  assert.match(formToStops([form[0]]).errors._list, /at least one pickup and one delivery/);
  assert.match(formToStops([form[0], { ...form[1], stop_type: 'pickup' }]).errors._list, /delivery/);
  assert.match(formToStops([{ ...form[0], stop_type: 'delivery' }, form[1]]).errors._list, /pickup/);
});

test('Pickup # only on pickups; deliveries keep a Delivery / PO # (first line of the stop notes)', () => {
  assert.deepEqual(splitDeliveryRef('Delivery # PO-55\nCall ahead'), { ref: 'PO-55', notes: 'Call ahead' });
  assert.deepEqual(splitDeliveryRef('Call ahead'), { ref: '', notes: 'Call ahead' });
  assert.equal(joinDeliveryRef(' PO-9 ', ''), 'Delivery # PO-9');
  assert.equal(joinDeliveryRef('', ''), null);
  const form = stopsToForm(STOPS);
  assert.equal(form[1].delivery_number, 'PO-55'); assert.equal(form[1].notes, 'Call ahead');
  assert.equal(form[0].delivery_number, ''); assert.equal(form[0].notes, 'Dock 4', 'pickup notes are never parsed');
  const { payload } = formToStops(form);
  assert.equal(payload[0].pickup_number, 'PU-777');
  assert.equal(payload[1].pickup_number, null);
  assert.equal(payload[1].notes, 'Delivery # PO-55\nCall ahead', 'round-trips unchanged');
  // a pickup # typed on a row that becomes a delivery is dropped (and the reverse)
  const flipped = formToStops([{ ...form[0] }, { ...form[1], stop_type: 'pickup', pickup_number: 'X1' }, { ...blankStop('delivery'), city: 'Warrenton', state: 'OR', pickup_number: 'NOPE', delivery_number: 'D-3' }]).payload;
  assert.equal(flipped[1].pickup_number, 'X1'); assert.equal(flipped[1].notes, 'Delivery # PO-55\nCall ahead'.split('\n')[1]);
  assert.equal(flipped[2].pickup_number, null); assert.equal(flipped[2].notes, 'Delivery # D-3');
  assert.ok(formToStops([form[0], { ...form[1], delivery_number: 'x'.repeat(81) }]).errors[form[1].key].delivery_number);
  const ed = read('app/components/StopsEditor.js');
  assert.match(ed, /x\.stop_type === 'pickup' && <Field label="Pickup #"/);
  assert.match(ed, /x\.stop_type === 'delivery' && <Field label="Delivery \/ PO #"/);
});

test('kept stops keep their ids, check-off and contact fields; new stops have no id; order is the list order', () => {
  const l = openWithNewStop(STOPS, 'delivery');
  Object.assign(l[1], { company_name: 'Middle Stop (FAKE)', city: 'Warrenton', state: 'or', zip: '97146', delivery_number: 'MID-1' });
  const { errors, payload } = formToStops(l);
  assert.deepEqual(errors, {});
  assert.deepEqual(payload.map((x) => x.id), ['11', undefined, '12']);
  assert.deepEqual(payload.map((x) => x.city), ['Lathrop', 'Warrenton', 'Hillsboro']);
  assert.equal(payload[1].state, 'OR'); assert.equal(payload[1].notes, 'Delivery # MID-1');
  assert.equal(payload[0].contact_name, 'Pat (FAKE)'); assert.equal(payload[0].contact_phone, '555-0100');
  assert.equal('contact_name' in payload[1], false);
  for (const p of payload) for (const k of ['completed_at', 'completion', 'done', 'lat', 'facility_id']) assert.equal(k in p, false, `${k} never sent`);
  assert.equal(l[0].done, true); assert.equal(l[2].done, false);
});

test('a checked-off stop can’t be removed', () => {
  const l = stopsToForm(STOPS);
  assert.equal(removedDoneStops(STOPS, l).length, 0);
  assert.equal(removedDoneStops(STOPS, [l[1], { ...blankStop('pickup'), city: 'X' }]).length, 1);
  assert.match(read('app/components/StopsEditor.js'), /disabled=\{stops\.length <= 2 \|\| \(lockDone && x\.done\)\}/);
});

const sb = (fn) => ({ calls: [], rpc: async function (n, a) { this.calls.push([n, a]); return fn(n, a); } });
test('saveOwnerStops: same RPC as Dispatch, owner wording, degrades when the function is missing', async () => {
  const l = openWithNewStop(STOPS, 'pickup');
  Object.assign(l[1], { city: 'Tracy', state: 'CA', pickup_number: 'PU-2' });
  const ok = sb(() => ({ data: [{ id: 11 }, { id: 99 }, { id: 12 }], error: null }));
  const r = await saveOwnerStops(ok, 'L-FAKE', STOPS, l);
  assert.equal(r.ok, true); assert.equal(r.stops.length, 3);
  assert.equal(ok.calls[0][0], 'dispatch_save_stops'); assert.equal(ok.calls[0][1].p_load, 'L-FAKE');
  assert.equal(ok.calls[0][1].p_stops[1].pickup_number, 'PU-2');
  const bad = await saveOwnerStops(ok, 'L-FAKE', STOPS, [l[0]]);
  assert.equal(bad.ok, false); assert.ok(bad.errors._list); assert.equal(ok.calls.length, 1, 'invalid list never calls the RPC');
  const gone = await saveOwnerStops(ok, 'L-FAKE', STOPS, [l[1], l[2]]);
  assert.match(gone.error, /checked-off stop/); assert.equal(ok.calls.length, 1);
  const na = await saveOwnerStops(sb(() => ({ data: null, error: { message: 'not_allowed' } })), 'L', STOPS, l);
  assert.equal(na.error, 'Only the load owner can change stops here.');
  const miss = await saveOwnerStops(sb(() => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })), 'L', STOPS, l);
  assert.equal(miss.ok, false); assert.equal(miss.setup, true); assert.equal(miss.error, OWNER_STOPS_SETUP_MSG);
  const stale = await saveOwnerStops(sb(() => ({ data: null, error: { message: 'bad_stops' } })), 'L', STOPS, l);
  assert.match(stale.error, /changed on another screen/);
});

test('load page: editor for owners only, inside the Stops card; no direct stops writes', () => {
  const page = read('app/loads/[id]/page.js');
  assert.match(page, /import OwnerStopsEditor from '\.\.\/\.\.\/components\/OwnerStopsEditor'/);
  assert.match(page, /\{owner && <OwnerStopsEditor supabase=\{supabase\} load=\{load\}/);
  const ed = read('app/components/OwnerStopsEditor.js'), lib = read('app/lib/ownerStops.js');
  assert.match(ed, /if \(!canOwnerEditStops\(load\)\) return null;/);
  assert.match(ed, />\+ Add stop</); assert.match(ed, /lockDone addBeforeLastDelivery flat/);
  assert.match(ed, /notifyLoadChanged\(load\.id\)/);
  for (const src of [ed, lib]) assert.doesNotMatch(src, /from\('stops'\)|from\('loads'\)/);
  for (const src of [ed, lib]) assert.doesNotMatch(src, /\b(AI|bot|Claude|GPT)\b/);
});
