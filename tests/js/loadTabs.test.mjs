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

test('tabs order and status → tab mapping (Marc Nov 9: delivered under Past)', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['Active', 'Pending', 'Booked', 'Past']);
  // Pending = invoiced only (awaiting payment). Delivered joins paid/cancelled in Past.
  const m = { dispatched: 'active', in_transit: 'active', delivered: 'past', invoiced: 'pending', booked: 'booked', paid: 'past', cancelled: 'past' };
  for (const [s, t] of Object.entries(m)) assert.equal(tabFor(s), t, s);
  assert.deepEqual(TABS.find((t) => t.id === 'pending').statuses, ['invoiced']);
  assert.deepEqual(TABS.find((t) => t.id === 'past').statuses, ['delivered', 'paid', 'cancelled']);
});

test('unknown / missing status goes to Active', () => {
  for (const s of ['on_hold', '', null, undefined, 'PAID']) assert.equal(tabFor(s), 'active');
});

test('parseTab defaults to active', () => {
  assert.equal(parseTab('past'), 'past');
  assert.equal(parseTab(null), 'active');
  assert.equal(parseTab('nope'), 'active');
});

test('countByTab counts every load exactly once (matches the lists)', () => {
  const loads = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled', 'weird'].map((s, i) => L(i, s));
  const c = countByTab(loads);
  assert.deepEqual(c, { active: 3, pending: 1, booked: 1, past: 3 });
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), loads.length);
  // Counts equal list lengths for each tab.
  for (const t of TABS) assert.equal(c[t.id], groupLoads(loads, t.id).flatMap((g) => g.loads).length, t.id);
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

test('Past groups by delivery date, newest first (includes delivered)', () => {
  const loads = [
    L('a', 'paid', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z'),
    L('b', 'cancelled', '2026-10-05T15:00:00Z', '2026-10-09T15:00:00Z'),
    L('c', 'paid', '2026-10-08T15:00:00Z', '2026-10-09T18:00:00Z'),
    L('d', 'delivered', '2026-10-08T15:00:00Z', '2026-10-11T18:00:00Z'),
  ];
  const g = groupLoads(loads, 'past');
  assert.deepEqual(g.map((x) => x.key), ['2026-10-11', '2026-10-09', '2026-10-02']);
  assert.deepEqual(g[0].loads.map((l) => l.id), ['d']);
  assert.deepEqual(g[1].loads.map((l) => l.id), ['c', 'b']);
  assert.deepEqual(groupLoads(loads, 'pending'), []);
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

test('mixed ET/PT stops: each date heading appears once, in order', () => {
  const S = (id, status, ts, tz, type = 'pickup') => ({ id, status, created_at: '2026-10-01T00:00:00Z',
    stops: [{ sequence: 1, stop_type: 'pickup', appointment_start: type === 'pickup' ? ts : null, timezone: tz },
      { sequence: 2, stop_type: 'delivery', appointment_start: type === 'delivery' ? ts : null, timezone: tz }] });
  const loads = [
    S('pt-12-late', 'dispatched', '2026-10-13T04:30:00Z', 'America/Los_Angeles'), // Oct 12 9:30 PM PT
    S('et-13-1am', 'dispatched', '2026-10-13T05:00:00Z', 'America/New_York'),      // Oct 13 1:00 AM ET
    S('pt-12-11pm', 'in_transit', '2026-10-13T06:00:00Z', 'America/Los_Angeles'),  // Oct 12 11:00 PM PT
    S('et-13-9am', 'dispatched', '2026-10-13T13:00:00Z', 'America/New_York'),      // Oct 13 9:00 AM ET
    S('pt-13-am', 'dispatched', '2026-10-13T16:00:00Z', 'America/Los_Angeles'),    // Oct 13 9:00 AM PT
  ];
  const g = groupLoads(loads, 'active');
  assert.deepEqual(g.map((x) => x.key), ['2026-10-12', '2026-10-13']);
  assert.deepEqual(g.map((x) => x.loads.map((l) => l.id)), [['pt-12-late', 'pt-12-11pm'], ['et-13-1am', 'et-13-9am', 'pt-13-am']]);
  const labels = g.map((x) => groupLabel(x.key, new Date(2026, 9, 12, 20)));
  assert.deepEqual(labels, ['Today', 'Tomorrow']);
  assert.equal(new Set(labels).size, labels.length);

  const past = loads.map((l) => ({ ...l, status: 'paid', stops: l.stops.map((s) => ({ ...s, appointment_start: s.stop_type === 'delivery' ? l.stops[0].appointment_start : null })) }));
  const gp = groupLoads(past, 'past');
  assert.deepEqual(gp.map((x) => x.key), ['2026-10-13', '2026-10-12']);
  assert.deepEqual(gp[0].loads.map((l) => l.id), ['pt-13-am', 'et-13-9am', 'et-13-1am']);
});

test('Marc bug: delivered loads land in Past, not Pending; counts match lists', () => {
  // Fake stand-ins for the screenshot (never real load numbers). Six delivered + a few others.
  const loads = [
    L('d1', 'delivered', '2026-10-20T15:00:00Z', '2026-10-21T18:00:00Z'),
    L('d2', 'delivered', '2026-10-22T15:00:00Z', '2026-10-23T18:00:00Z'),
    L('d3', 'delivered', '2026-11-01T15:00:00Z', '2026-11-02T18:00:00Z'),
    L('d4', 'delivered', '2026-11-03T15:00:00Z', '2026-11-04T18:00:00Z'),
    L('d5', 'delivered', '2026-11-05T15:00:00Z', '2026-11-06T18:00:00Z'),
    L('d6', 'delivered', '2026-11-07T15:00:00Z', '2026-11-08T18:00:00Z'),
    L('paid1', 'paid', '2026-09-01T15:00:00Z', '2026-09-02T18:00:00Z'),
    L('paid2', 'paid', '2026-09-10T15:00:00Z', '2026-09-11T18:00:00Z'),
    L('can1', 'cancelled', '2026-09-15T15:00:00Z', '2026-09-16T18:00:00Z'),
    L('can2', 'cancelled', '2026-09-20T15:00:00Z', '2026-09-21T18:00:00Z'),
    L('inv1', 'invoiced', '2026-10-01T15:00:00Z', '2026-10-02T18:00:00Z'),
    L('tr', 'in_transit', '2026-11-09T15:00:00Z', '2026-11-10T18:00:00Z'),
    L('bk', 'booked', '2026-11-12T15:00:00Z', '2026-11-13T18:00:00Z'),
  ];
  const c = countByTab(loads);
  assert.equal(c.pending, 1, 'only the invoiced load');
  assert.equal(c.past, 10, '6 delivered + 2 paid + 2 cancelled');
  assert.equal(c.active, 1);
  assert.equal(c.booked, 1);
  const pastIds = groupLoads(loads, 'past').flatMap((g) => g.loads).map((l) => l.id);
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'paid1', 'paid2', 'can1', 'can2']) assert.ok(pastIds.includes(id), id);
  assert.deepEqual(groupLoads(loads, 'pending').flatMap((g) => g.loads).map((l) => l.id), ['inv1']);
  assert.equal(tabFor('delivered'), 'past');
  assert.equal(tabFor('invoiced'), 'pending');
});

test('status matrix: in transit, booked/upcoming, cancelled, delivered-unpaid, invoiced, paid', () => {
  assert.equal(tabFor('in_transit'), 'active');
  assert.equal(tabFor('dispatched'), 'active');
  assert.equal(tabFor('booked'), 'booked');
  assert.equal(tabFor('cancelled'), 'past');
  assert.equal(tabFor('delivered'), 'past', 'delivered but unpaid → Past (badge still says Delivered)');
  assert.equal(tabFor('invoiced'), 'pending', 'invoiced awaiting payment stays Pending');
  assert.equal(tabFor('paid'), 'past');
});

test('Pending = invoiced only; empty when nothing is invoiced', () => {
  const loads = [L('d', 'delivered', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z'), L('p', 'paid', '2026-10-01T15:00:00Z', '2026-10-03T15:00:00Z')];
  assert.equal(countByTab(loads).pending, 0);
  assert.deepEqual(groupLoads(loads, 'pending'), []);
  assert.equal(countByTab(loads).past, 2);
});

test('date edge: delivery day near midnight across Chicago vs LA', () => {
  // 2026-11-09 05:30 UTC = Nov 8 11:30 PM CT = Nov 8 9:30 PM PT
  const ct = { id: 'ct', status: 'delivered', created_at: '2026-10-01T00:00:00Z', stops: [
    { sequence: 1, stop_type: 'pickup', appointment_start: '2026-11-08T15:00:00Z', timezone: 'America/Chicago' },
    { sequence: 2, stop_type: 'delivery', appointment_start: '2026-11-09T05:30:00Z', timezone: 'America/Chicago' },
  ]};
  const pt = { id: 'pt', status: 'delivered', created_at: '2026-10-01T00:00:00Z', stops: [
    { sequence: 1, stop_type: 'pickup', appointment_start: '2026-11-08T15:00:00Z', timezone: 'America/Los_Angeles' },
    { sequence: 2, stop_type: 'delivery', appointment_start: '2026-11-09T05:30:00Z', timezone: 'America/Los_Angeles' },
  ]};
  assert.equal(dayKey(ct.stops[1].appointment_start, 'America/Chicago'), '2026-11-08');
  assert.equal(dayKey(pt.stops[1].appointment_start, 'America/Los_Angeles'), '2026-11-08');
  // Same absolute time, next hour → Nov 9 in CT, still Nov 8 in PT
  assert.equal(dayKey('2026-11-09T06:30:00Z', 'America/Chicago'), '2026-11-09');
  assert.equal(dayKey('2026-11-09T06:30:00Z', 'America/Los_Angeles'), '2026-11-08');
  const g = groupLoads([ct, pt], 'past');
  assert.equal(g.length, 1);
  assert.equal(g[0].key, '2026-11-08');
  assert.deepEqual(g[0].loads.map((l) => l.id).sort(), ['ct', 'pt']);
});

test('date edge: undated delivered load still Past, under No date', () => {
  const loads = [L('x', 'delivered', null, null), L('y', 'paid', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z')];
  const g = groupLoads(loads, 'past');
  assert.deepEqual(g.map((x) => x.key), ['2026-10-02', null]);
  assert.equal(groupLabel(null), 'No date');
  assert.equal(countByTab(loads).past, 2);
  assert.equal(countByTab(loads).pending, 0);
});

test('?tab=pending still resolves; delivered never appears there', () => {
  assert.equal(parseTab('pending'), 'pending');
  const loads = [L('d', 'delivered', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z'), L('i', 'invoiced', '2026-10-01T15:00:00Z', '2026-10-03T15:00:00Z')];
  assert.deepEqual(groupLoads(loads, 'pending').flatMap((g) => g.loads).map((l) => l.id), ['i']);
  assert.deepEqual(groupLoads(loads, 'past').flatMap((g) => g.loads).map((l) => l.id), ['d']);
});
