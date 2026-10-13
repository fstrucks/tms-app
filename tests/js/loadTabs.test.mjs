import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, tabFor, parseTab, countByTab, groupLoads, groupLabel, currentInTransit, pickupStop, deliveryStop, dayKey } from '../../app/lib/loadTabs.js';

const L = (id, status, pu, del, extra = {}) => ({
  id, status, created_at: '2026-10-01T00:00:00Z',
  stops: [
    { sequence: 2, stop_type: 'delivery', city: 'B', appointment_start: del, timezone: 'America/Chicago' },
    { sequence: 1, stop_type: 'pickup', city: 'A', appointment_start: pu, timezone: 'America/Chicago' },
  ], ...extra,
});

test('tabs order and option A mapping', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['Active', 'Pending', 'Booked', 'Past']);
  const m = { dispatched: 'active', in_transit: 'active', delivered: 'pending', invoiced: 'pending', booked: 'booked', paid: 'past', cancelled: 'past' };
  for (const [s, t] of Object.entries(m)) assert.equal(tabFor(s), t, s);
});

test('unknown / missing status goes to Active', () => {
  for (const s of ['on_hold', '', null, undefined, 'PAID']) assert.equal(tabFor(s), 'active');
});

test('parseTab defaults to active', () => {
  assert.equal(parseTab('past'), 'past');
  assert.equal(parseTab(null), 'active');
  assert.equal(parseTab('nope'), 'active');
});

test('countByTab counts every load exactly once', () => {
  const loads = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled', 'weird'].map((s, i) => L(i, s));
  const c = countByTab(loads);
  assert.deepEqual(c, { active: 3, pending: 2, booked: 1, past: 2 });
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), loads.length);
});

test('pickup/delivery stops by sequence and stop_type', () => {
  const l = L(1, 'booked', '2026-10-13T15:00:00Z', '2026-10-14T15:00:00Z');
  assert.equal(pickupStop(l).city, 'A');
  assert.equal(deliveryStop(l).city, 'B');
  assert.equal(pickupStop({ stops: [] }), null);
});

test('dayKey uses the stop zone', () => {
  assert.equal(dayKey('2026-10-13T03:00:00Z', 'America/Chicago'), '2026-10-12');
  assert.equal(dayKey('2026-10-13T03:00:00Z', 'Bad/Zone') !== null, true);
  assert.equal(dayKey(null), null);
});

test('Active groups by pickup date, soonest first; undated last', () => {
  const loads = [
    L('x', 'dispatched', '2026-10-15T15:00:00Z', '2026-10-16T15:00:00Z'),
    L('y', 'in_transit', '2026-10-13T15:00:00Z', '2026-10-20T15:00:00Z'),
    L('z', 'dispatched', null, null),
    L('w', 'in_transit', '2026-10-13T20:00:00Z', '2026-10-14T15:00:00Z'),
    L('p', 'paid', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z'),
  ];
  const g = groupLoads(loads, 'active');
  assert.deepEqual(g.map((x) => x.key), ['2026-10-13', '2026-10-15', null]);
  assert.deepEqual(g[0].loads.map((l) => l.id), ['y', 'w']);
});

test('Past groups by delivery date, newest first', () => {
  const loads = [
    L('a', 'paid', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z'),
    L('b', 'cancelled', '2026-10-05T15:00:00Z', '2026-10-09T15:00:00Z'),
    L('c', 'paid', '2026-10-08T15:00:00Z', '2026-10-09T18:00:00Z'),
    L('d', 'delivered', '2026-10-08T15:00:00Z', '2026-10-11T18:00:00Z'),
  ];
  const g = groupLoads(loads, 'past');
  assert.deepEqual(g.map((x) => x.key), ['2026-10-09', '2026-10-02']);
  assert.deepEqual(g[0].loads.map((l) => l.id), ['c', 'b']);
  assert.deepEqual(groupLoads(loads, 'pending').map((x) => x.loads.map((l) => l.id)), [['d']]);
});

test('groupLabel', () => {
  const now = new Date(2026, 9, 12, 9);
  assert.equal(groupLabel('2026-10-12', now), 'Today');
  assert.equal(groupLabel('2026-10-13', now), 'Tomorrow');
  assert.equal(groupLabel('2026-10-11', now), 'Yesterday');
  assert.equal(groupLabel('2026-10-20', now), 'Tue, Oct 20');
  assert.equal(groupLabel('2025-10-20', now), 'Mon, Oct 20, 2025');
  assert.equal(groupLabel(null, now), 'No date');
});

test('currentInTransit picks the in_transit load only', () => {
  const loads = [L('d', 'dispatched', '2026-10-10T15:00:00Z'), L('t2', 'in_transit', '2026-10-12T15:00:00Z'), L('t1', 'in_transit', '2026-10-11T15:00:00Z')];
  assert.equal(currentInTransit(loads).id, 't1');
  assert.equal(currentInTransit([L('d', 'dispatched')]), null);
});
