// Home Current load card shows every stop (Marc, Nov 27 2026: "this should show all the stops").
// Route line lists every stop in load-page order; Option B lists all stops (no "Other stops" toggle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeStops, routeStopsText, routeLabel, stopRows, stopPlace, layoutFor, nextStopIndex } from '../../app/lib/homeCurrentLoad.js';

const NOW = Date.parse('2026-11-27T18:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const stop = (sequence, stop_type, city, state, at, extra = {}) => ({ id: `s${sequence}`, sequence, stop_type, city, state,
  company_name: `${city} Test Co (FAKE)`, address_line1: '1 Test Rd', appointment_start: at == null ? null : iso(at), ...extra });
// FAKE load shaped like #69813: 3 stops, delivered out of order from the API.
const three = { id: 'fake-3', status: 'in_transit', stops: [
  stop(3, 'delivery', 'Hillsboro', 'OR', NOW + 10 * H),
  stop(1, 'pickup', 'Lathrop', 'CA', NOW - 20 * H),
  stop(2, 'delivery', 'Warrenton', 'OR', NOW + 4 * H),
] };

test('route line: every stop in sequence order, not just first → last', () => {
  assert.deepEqual(routeStops(three), ['Lathrop, CA', 'Warrenton, OR', 'Hillsboro, OR']);
  assert.equal(routeStopsText(three), 'Lathrop, CA → Warrenton, OR → Hillsboro, OR');
  assert.equal(routeLabel(three), 'Lathrop, CA → Hillsboro, OR', 'routeLabel stays the short first-pickup → last-delivery form');
});

test('route line: 2-stop loads unchanged, 1-stop shows one place, no stops shows a dash', () => {
  const two = { stops: [stop(2, 'delivery', 'Dallas', 'TX', null), stop(1, 'pickup', 'Austin', 'TX', null)] };
  assert.equal(routeStopsText(two), routeLabel(two));
  assert.equal(routeStopsText(two), 'Austin, TX → Dallas, TX');
  assert.deepEqual(routeStops({ stops: [stop(1, 'pickup', 'Reno', 'NV', null)] }), ['Reno, NV']);
  assert.deepEqual(routeStops({ stops: [] }), ['—']);
  assert.deepEqual(routeStops(null), ['—']);
});

test('route line: facility name when there is no city/state; dash when nothing', () => {
  assert.equal(stopPlace({ company_name: ' Eagle Distributing (FAKE) ' }), 'Eagle Distributing (FAKE)');
  assert.equal(stopPlace({ city: 'Lathrop' }), 'Lathrop');
  assert.equal(stopPlace({}), '—');
});

test('stop rows: every stop in order; next highlighted; earlier stops done; later upcoming', () => {
  assert.equal(layoutFor(three), 'B');
  const rows = stopRows(three, NOW);
  assert.deepEqual(rows.map((r) => r.stop.city), ['Lathrop', 'Warrenton', 'Hillsboro']);
  assert.deepEqual(rows.map((r) => r.state), ['done', 'next', 'upcoming']);
  assert.equal(rows.findIndex((r) => r.state === 'next'), nextStopIndex(three, NOW));
});

test('stop rows: completion data drives done / next; skipped flagged; all done keeps the last highlighted', () => {
  const withDone = { status: 'in_transit', stops: [
    stop(1, 'pickup', 'A', 'CA', null, { completed_at: iso(NOW - 9 * H), completion: 'done' }),
    stop(2, 'pickup', 'B', 'CA', null, { completed_at: iso(NOW - 5 * H), completion: 'skipped' }),
    stop(3, 'delivery', 'C', 'OR', null, { completed_at: null, completion: null }),
    stop(4, 'delivery', 'D', 'OR', null, { completed_at: null, completion: null }),
    stop(5, 'delivery', 'E', 'WA', null, { completed_at: null, completion: null }),
  ] };
  const rows = stopRows(withDone, NOW);
  assert.deepEqual(rows.map((r) => r.state), ['done', 'done', 'next', 'upcoming', 'upcoming']);
  assert.deepEqual(rows.map((r) => r.skipped), [false, true, false, false, false]);
  const all = { status: 'delivered', stops: withDone.stops.map((x) => ({ ...x, completed_at: iso(NOW), completion: 'done' })) };
  assert.deepEqual(stopRows(all, NOW).map((r) => r.state), ['done', 'done', 'done', 'done', 'next']);
});

test('stop rows: before pickup the first stop is next and nothing is muted', () => {
  const booked = { ...three, status: 'dispatched' };
  assert.deepEqual(stopRows(booked, NOW).map((r) => r.state), ['next', 'upcoming', 'upcoming']);
});

const card = readFileSync(new URL('../../app/components/HomeCurrentLoad.js', import.meta.url), 'utf8');

test('card source: no collapsed "Other stops" toggle; all stops listed; route line breaks between stops', () => {
  assert.doesNotMatch(card, /Other stops/);
  assert.doesNotMatch(card, /<details|<summary/);
  assert.match(card, /const rows = stopRows\(load, now\);/);
  assert.match(card, /data-testid="home-stop-row" data-state=\{state\}/);
  assert.match(card, /<HomeRouteLine load=\{load\} \/>/);
  assert.match(card, /testId="home-route"/);
  assert.match(card, /stopTestId="home-route-stop"/);
  // Up next rows list every stop, same wrapping route line as the Current load card
  assert.match(card, /<StatusBadge status=\{l\.status\} \/> <RouteLine load=\{l\}/);
  assert.match(card, /testId="up-next-route"/);
});

test('card source: 1-stop loads show the stop once; #189 Open load / Rate con buttons intact', () => {
  assert.match(card, /\{st\.length > 1 && <StopBlock load=\{load\} stop=\{st\[st\.length - 1\]\} \/>\}/);
  assert.match(card, /data-testid="home-load-actions"/);
  assert.match(card, />Open load<\/Link>/);
  assert.match(card, />Rate con<\/button>/);
});
