// Rate con scan: pickup number and full street addresses reach the load (Nov 2). Fake Uber-Freight-style fixture only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRateConStops, bestAddress, cleanPickupNumber, composeAddress, hasStreet } from '../../app/lib/rateconStops.js';
import { schema, PROMPT } from '../../app/lib/rateconExtract.js';
import { pickupNumberText, PICKUP_FALLBACK } from '../../app/lib/homeCurrentLoad.js';

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/ratecon/uber-freight-fake.json', import.meta.url), 'utf8'));
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Same "Refs:" line the load RPC writes into loads.notes from reference_numbers.
const refsNotes = (x) => (x.reference_numbers?.length ? `Refs: ${x.reference_numbers.join(', ')}` : '');

test('schema asks for street / city / state / zip and the pickup number per stop (strict: all required)', () => {
  const stop = schema.properties.pickup.type ? schema.properties.pickup : null;
  for (const k of ['street', 'city', 'state', 'zip', 'pickup_number', 'address', 'date', 'time']) {
    assert.ok(stop.properties[k], k);
    assert.ok(stop.required.includes(k), `${k} required`);
  }
  assert.equal(stop.additionalProperties, false);
  assert.equal(schema.properties.delivery, stop);
  assert.match(stop.properties.pickup_number.description, /PU#/);
  assert.match(PROMPT, /street line is often printed on its own line under the facility name/);
  assert.match(PROMPT, /pickup\.pickup_number/);
});

test('fake Uber Freight rate con: city-only stop header loses to the street address; pickup number labeled', () => {
  const x = normalizeRateConStops(fixture());
  assert.equal(x.pickup.address, '100 Example Industrial Way, Vancouver, WA 98660');
  assert.equal(x.delivery.address, '200 Sample Distribution Rd, Hanover, PA 17331');
  assert.equal(x.pickup.pickup_number, '88123');
  assert.deepEqual(x.reference_numbers, ['PU# 88123', 'PO 55-TEST']);
  // Untouched fields stay.
  assert.equal(x.load_number, '9990001111');
  assert.equal(x.rate, 6100);
});

test('Current Load card shows the pickup number from the Refs line the load gets', () => {
  const before = fixture();
  const stop = { stop_type: 'pickup', sequence: 1 };
  assert.equal(pickupNumberText({ notes: refsNotes(before), stops: [stop] }, stop), PICKUP_FALLBACK);
  const x = normalizeRateConStops(before);
  assert.equal(pickupNumberText({ notes: refsNotes(x), stops: [stop] }, stop), 'Pickup # 88123');
});

test('helpers', () => {
  assert.equal(hasStreet('4800 NW Example Rd'), true);
  assert.equal(hasStreet('Vancouver, WA'), false);
  assert.equal(hasStreet('PO Box 12, Hanover, PA'), true);
  assert.equal(composeAddress({ street: '1 A St', city: 'Hanover', state: 'PA', zip: '17331' }), '1 A St, Hanover, PA 17331');
  assert.equal(composeAddress({ city: 'Hanover', state: 'PA' }), 'Hanover, PA');
  assert.equal(bestAddress('Hanover, PA', null, '', 'Hanover, PA 17331'), 'Hanover, PA 17331');
  assert.equal(bestAddress(null, ''), null);
  for (const [i, o] of [['PU# 88123', '88123'], ['Pickup Number: A-12', 'A-12'], ['P/U 889', '889'], [' 4471 ', '4471'], ['see BOL', null], [null, null]]) assert.equal(cleanPickupNumber(i), o, String(i));
});

test('no pickup number, no stops, or junk input: nothing invented', () => {
  const x = fixture();
  x.pickup.pickup_number = null;
  const n = normalizeRateConStops(x);
  assert.deepEqual(n.reference_numbers, ['88123', 'PO 55-TEST']);
  assert.equal(n.pickup.pickup_number, null);
  assert.equal(normalizeRateConStops(null), null);
  const empty = normalizeRateConStops({ pickup: null, delivery: null, shipper: null, receiver: null, reference_numbers: null });
  assert.equal(empty.pickup, null);
  assert.equal(empty.reference_numbers, null);
  // Shipper street only, no pickup object: a pickup is built so the RPC still gets the address.
  const only = normalizeRateConStops({ shipper: { name: 'X', address: '9 Test Ave, Hanover, PA 17331' }, pickup: null });
  assert.deepEqual(only.pickup, { date: null, time: null, address: '9 Test Ave, Hanover, PA 17331', pickup_number: null });
});

test('both scan paths (upload and email-in) normalize before saving', () => {
  assert.match(src('../../app/api/extract/route.js'), /extracted = \{ \.\.\.normalizeRateConStops\(loadData\)/);
  assert.match(src('../../app/lib/rateconEmail.js'), /const extracted = \{ \.\.\.normalizeRateConStops\(loadData\)/);
  const lib = src('../../app/lib/rateconStops.js');
  assert.doesNotMatch(lib, /from ['"](?:node:|@supabase|openai)/);
});
