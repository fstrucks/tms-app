// Loads list, Dispatch list, Dispatch boards, and Home Up next show every stop (Marc, Nov 28 2026).
// 2-stop rows stay pickup → delivery (with dates on Loads / Dispatch / On the road). 3+ list every place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stopPlace, routeStops, routeStopsText, stopSummaryText, isShortListRoute, listRoutePlaces, listRouteText,
} from '../../app/lib/routeLine.js';
import { pickupStop, deliveryStop } from '../../app/lib/loadTabs.js';
import { routeLabel } from '../../app/lib/homeCurrentLoad.js';

const NOW = Date.parse('2026-11-28T18:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const stop = (sequence, stop_type, city, state, at, extra = {}) => ({
  id: `s${sequence}`, sequence, stop_type, city, state,
  company_name: `${city || 'No City'} Test Co (FAKE)`, address_line1: '1 Test Rd',
  appointment_start: at == null ? null : iso(at), timezone: at == null ? null : 'America/Los_Angeles', ...extra,
});
const three = { id: 'fake-3', status: 'dispatched', stops: [
  stop(3, 'delivery', 'Hillsboro', 'OR', NOW + 10 * H),
  stop(1, 'pickup', 'Lathrop', 'CA', NOW - 20 * H),
  stop(2, 'delivery', 'Warrenton', 'OR', NOW + 4 * H),
] };
const two = { id: 'fake-2', status: 'dispatched', stops: [
  stop(2, 'delivery', 'Hillsboro', 'OR', NOW + 8 * H),
  stop(1, 'pickup', 'Lathrop', 'CA', NOW - 6 * H),
] };
const five = { id: 'fake-5', status: 'booked', stops: [
  stop(1, 'pickup', 'Rancho Cucamonga', 'CA', NOW - 30 * H),
  stop(2, 'pickup', 'West Sacramento', 'CA', NOW - 20 * H),
  stop(3, 'delivery', 'South San Francisco', 'CA', NOW + 2 * H),
  stop(4, 'delivery', 'Klamath Falls', 'OR', NOW + 14 * H),
  stop(5, 'delivery', null, null, NOW + 26 * H, { company_name: 'Test Northwest Fulfillment Warehouse Number Two (FAKE)' }),
] };

test('route line helpers: every stop in sequence order, 2-stop matches the short label, empty is a dash', () => {
  assert.deepEqual(routeStops(three), ['Lathrop, CA', 'Warrenton, OR', 'Hillsboro, OR']);
  assert.equal(routeStopsText(three), 'Lathrop, CA → Warrenton, OR → Hillsboro, OR');
  assert.equal(routeStopsText(two), routeLabel(two));
  assert.equal(routeStopsText(two), 'Lathrop, CA → Hillsboro, OR');
  assert.deepEqual(routeStops({ stops: [] }), ['—']);
  assert.deepEqual(routeStops(null), ['—']);
});

test('stopPlace: facility name when there is no city/state; dash when nothing', () => {
  assert.equal(stopPlace({ company_name: ' Eagle Distributing (FAKE) ' }), 'Eagle Distributing (FAKE)');
  assert.equal(stopPlace({ city: 'Lathrop' }), 'Lathrop');
  assert.equal(stopPlace({}), '—');
});

test('list rows: 2-stop with dates matches today\'s stopSummary(pickup) → stopSummary(delivery)', () => {
  assert.equal(isShortListRoute(two), true);
  assert.equal(isShortListRoute(three), false);
  const dated = `${stopSummaryText(pickupStop(two))} → ${stopSummaryText(deliveryStop(two))}`;
  assert.equal(listRouteText(two, { datesOnShort: true }), dated);
  assert.match(dated, /Lathrop, CA · /);
  assert.match(dated, /Hillsboro, OR · /);
  assert.notEqual(dated, listRouteText(two), 'dates appear only when datesOnShort is on');
  assert.equal(listRouteText(two), 'Lathrop, CA → Hillsboro, OR', 'boards (no dates) stay city, ST → city, ST');
});

test('list rows: 3- and 5-stop list every place, no dates, out-of-order API rows still sequence-sorted', () => {
  assert.deepEqual(listRoutePlaces(three), ['Lathrop, CA', 'Warrenton, OR', 'Hillsboro, OR']);
  assert.equal(listRouteText(three), 'Lathrop, CA → Warrenton, OR → Hillsboro, OR');
  assert.doesNotMatch(listRouteText(three, { datesOnShort: true }), / · /, 'dates stay off once there are 3+ stops');
  assert.deepEqual(listRoutePlaces(five), [
    'Rancho Cucamonga, CA', 'West Sacramento, CA', 'South San Francisco, CA', 'Klamath Falls, OR',
    'Test Northwest Fulfillment Warehouse Number Two (FAKE)',
  ]);
  assert.match(listRouteText(five), /Rancho Cucamonga, CA → West Sacramento, CA → South San Francisco, CA → Klamath Falls, OR → Test Northwest/);
});

test('list rows: 1-stop and no-stops match the old pair / dash', () => {
  const one = { stops: [stop(1, 'pickup', 'Reno', 'NV', null)] };
  assert.deepEqual(listRoutePlaces(one), [stopPlace(pickupStop(one)), stopPlace(deliveryStop(one))]);
  assert.deepEqual(listRoutePlaces({ stops: [] }), ['—']);
});

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const routeLine = read('../../app/components/RouteLine.js');
const loadsData = read('../../app/loads/LoadsData.js');
const loadsTabs = read('../../app/components/LoadsTabs.js');
const dispatch = read('../../app/dispatch/page.js');
const boards = read('../../app/dispatch/boards/page.js');
const home = read('../../app/components/HomeCurrentLoad.js');

test('RouteLine: each stop is one wrapping unit with the arrow glued (nbsp) to the next place', () => {
  assert.match(routeLine, /display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere'/);
  assert.match(routeLine, /→\{'\\u00a0'\}/);
  assert.match(routeLine, /export function ListRoute/);
  assert.match(routeLine, /datesOnShort: dated/);
});

test('list sources: Loads, Dispatch, On the road, boards, and Up next use the shared route line', () => {
  assert.match(loadsData, /<ListRoute load=\{l\} dated testId="load-route"/);
  assert.doesNotMatch(loadsData, /pickupStop|deliveryStop|stopSummary/);
  assert.match(loadsData, /stops\(sequence, stop_type, company_name, city, state, appointment_start, timezone\)/,
    'the Loads query already selects every stop, not a pickup/delivery summary');
  assert.match(loadsTabs, /<ListRoute load=\{onRoad\} dated as="span" testId="on-road-route"/);
  assert.doesNotMatch(loadsTabs, /pickupStop|deliveryStop|stopSummary/);
  assert.match(dispatch, /<ListRoute load=\{l\} dated testId="dispatch-load-route"/);
  assert.doesNotMatch(dispatch, /pickupStop|deliveryStop|stopSummary|stops\.length > 2/);
  assert.match(boards, /<ListRoute load=\{l\} testId="board-load-route"/);
  assert.doesNotMatch(boards, /deliveryStop/);
  assert.doesNotMatch(boards, /textOverflow: 'ellipsis'/);
  assert.match(home, /testId="up-next-route"/);
  assert.doesNotMatch(home, /routeLabel\(l\)/);
});

test('these screens have no city search or filter that would ignore middle stops', () => {
  for (const [name, src] of [['LoadsData', loadsData], ['LoadsTabs', loadsTabs], ['dispatch', dispatch], ['boards', boards]]) {
    assert.doesNotMatch(src, /filter\(.*city|search.*city|q\.ilike\(/i, name);
  }
});
