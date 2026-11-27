// Home facility rating reminder card shows the facility's address (Marc, Nov 27): the stop's own address from the
// load, else the facility record's; "street, city, ST zip", at most 2 lines, Open in Maps, hidden when unknown.
// Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { cardAddress, pickCardAddress, cardMapsUrl } from '../../app/lib/facilityRatingPrompts.js';
import * as RP from '../../app/api/rating-prompts/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('cardAddress: full, partial and empty addresses, no stray commas or spaces', () => {
  assert.equal(cardAddress({ address_line1: '100 Fake Industrial Pkwy', city: 'Testville', state: 'TX', zip: '75000' }), '100 Fake Industrial Pkwy, Testville, TX 75000');
  assert.equal(cardAddress({ address_line1: '100 Fake Industrial Pkwy', city: 'Testville', state: 'TX' }), '100 Fake Industrial Pkwy, Testville, TX');
  assert.equal(cardAddress({ city: 'Testville', state: 'TX' }), 'Testville, TX');
  assert.equal(cardAddress({ city: 'Testville' }), 'Testville');
  assert.equal(cardAddress({ state: 'TX', zip: '75000' }), 'TX 75000');
  assert.equal(cardAddress({ address_line1: '  100   Fake  St ', city: ' ', state: '', zip: null }), '100 Fake St');
  for (const v of [null, undefined, {}, { address_line1: '', city: '  ', state: null, zip: '' }, { city: 42 }]) assert.equal(cardAddress(v), '');
});

test('pickCardAddress: the stop first, the facility record when the stop has no street', () => {
  const stop = { address_line1: '1 Stop Rd', city: 'Stopton', state: 'OK' };
  const fac = { address_line1: '9 Facility Ave', city: 'Factown', state: 'KS', zip: '66000' };
  assert.equal(pickCardAddress(stop, fac), '1 Stop Rd, Stopton, OK');
  assert.equal(pickCardAddress({}, fac), '9 Facility Ave, Factown, KS 66000', 'stop empty → facility');
  assert.equal(pickCardAddress(null, fac), '9 Facility Ave, Factown, KS 66000');
  assert.equal(pickCardAddress({ city: 'Stopton', state: 'OK' }, fac), '9 Facility Ave, Factown, KS 66000', 'facility street beats a city-only stop');
  assert.equal(pickCardAddress({ city: 'Stopton', state: 'OK' }, { city: 'Factown' }), 'Stopton, OK', 'neither has a street → stop partial');
  assert.equal(pickCardAddress({}, { city: 'Factown', state: 'KS' }), 'Factown, KS');
  assert.equal(pickCardAddress(null, null), '');
});

test('cardMapsUrl: Google Maps search on name + address, null without an address', () => {
  assert.equal(cardMapsUrl('Fake DC', '1 Stop Rd, Stopton, OK'), 'https://www.google.com/maps/search/?api=1&query=Fake%20DC%2C%201%20Stop%20Rd%2C%20Stopton%2C%20OK');
  assert.equal(cardMapsUrl('', 'Stopton, OK'), 'https://www.google.com/maps/search/?api=1&query=Stopton%2C%20OK');
  assert.equal(cardMapsUrl('Fake DC', ''), null);
});

const U = '00000000-0000-4000-8000-0000000000a2';
const F1 = '00000000-0000-4000-8000-0000000000f1', F2 = '00000000-0000-4000-8000-0000000000f2', F3 = '00000000-0000-4000-8000-0000000000f3';
const S1 = '00000000-0000-4000-8000-0000000000d1', S2 = '00000000-0000-4000-8000-0000000000d2', S3 = '00000000-0000-4000-8000-0000000000d3';
const row = (id, stop_id, facility_id, remind_at) => ({ id, user_id: U, load_id: '00000000-0000-4000-8000-0000000000b1', stop_id, facility_id, kind: 'delivery', status: 'pending', timezone: 'America/Chicago', remind_at, reminded_at: null, created_at: remind_at });

test('GET /api/rating-prompts: each card carries facilityAddress (stop, else facility, else empty)', async () => {
  const svc = fakeSupabase({ tables: {
    facility_rating_prompts: [row('p1', S1, F1, '2026-11-03T15:00:00Z'), row('p2', S2, F2, '2026-11-03T15:01:00Z'), row('p3', S3, F3, '2026-11-03T15:02:00Z')],
    stops: [{ id: S1, address_line1: '1 Stop Rd', city: 'Stopton', state: 'OK', zip: '73000' }, { id: S2, address_line1: null, city: null, state: null, zip: null }, { id: S3 }],
    facilities: [{ id: F1, name: 'Fake Distributing', address_line1: '9 Other Ave', city: 'Factown', state: 'KS' },
      { id: F2, name: 'Fake DC 9', address_line1: '9 Facility Ave', city: 'Factown', state: 'KS', zip: '66000' }, { id: F3, name: 'Fake Nowhere' }],
  } });
  const uc = fakeSupabase({ user: { id: U } });
  const r = await RP.GET(new Request('http://x/api/rating-prompts', { headers: { authorization: 'Bearer t' } }), { deps: { mkUserClient: () => uc, sb: svc, now: () => Date.parse('2026-11-03T16:00:00Z') } });
  const { cards } = await r.json();
  assert.deepEqual(cards.map((c) => [c.facilityName, c.facilityAddress]), [
    ['Fake Distributing', '1 Stop Rd, Stopton, OK 73000'], ['Fake DC 9', '9 Facility Ave, Factown, KS 66000'], ['Fake Nowhere', '']]);
});

test('reminder card source: address under the title, link colour + pin, 2-line clamp, Open in Maps, nothing when unknown', () => {
  const src = read('../../app/components/FacilityRatingReminders.js');
  assert.match(src, /<CardAddress name=\{c\.facilityName\} address=\{c\.facilityAddress\} \/>/);
  assert.match(src, /if \(!address\) return null;/, 'no empty line when unknown');
  assert.match(src, /WebkitLineClamp: 2/); assert.match(src, /fontSize: '0\.8rem'/);
  // Reads as tappable (Taylor's QA nit): link colour with a real underline, a pin before it, the label kept.
  const style = src.slice(src.indexOf('const addrStyle'), src.indexOf('export function CardAddress'));
  assert.match(style, /color: 'var\(--primary\)'/); assert.match(style, /textDecoration: 'underline'/);
  assert.doesNotMatch(style, /--text-muted|textDecorationColor/, 'not muted grey, no faint divider underline');
  assert.match(src, /<span aria-hidden="true">📍 <\/span>\{address\}<\/a>/);
  assert.match(src, /aria-label=\{`\$\{address\}, open in Maps`\}/);
  assert.match(src, /href=\{cardMapsUrl\(name, address\)\} target="_blank" rel="noopener noreferrer"/);
  assert.match(src, /data-testid="facility-reminder-address"/);
  const route = read('../../app/api/rating-prompts/route.js');
  assert.match(route, /from\('stops'\)\.select\(`id,\$\{ADDR\}`\)\.in\('id', stopIds\)/, 'stop ids only from the caller\'s own prompt rows');
  assert.doesNotMatch(src + route, /\b(AI|bot|Grok)\b/);
});
