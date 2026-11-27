// Home card: an In transit load whose pickup was never checked off (status set by hand, e.g. in Dispatch) keeps
// stop 1 as the next stop. Only a real check-off (stops.completed_at) marks a stop done (Nov 27 2026, QA #194 nit (a)).
// Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stopRows, nextStopIndex, layoutFor, routeStopsText } from '../../app/lib/homeCurrentLoad.js';
import { completedNextIndex, planStopAction } from '../../app/lib/stopProgress.js';

const H = 3600e3, NOW = Date.parse('2026-11-27T20:00:00Z');
const iso = (t) => new Date(t).toISOString();
const stop = (id, sequence, stop_type, city, apptOffsetH, extra = {}) => ({
  id, sequence, stop_type, city, state: 'OR', company_name: `TEST ${city}`,
  appointment_start: iso(NOW + apptOffsetH * H), appointment_end: null,
  completed_at: null, completion: null, completed_by: null, ...extra,
});
const done = (s, atH = -1, completion = 'done') => ({ ...s, completed_at: iso(NOW + atH * H), completion });
// Pickup 10 h ago (so a pickup the old rule skipped would be "Late"), deliveries later.
const three = () => [stop('s1', 1, 'pickup', 'Lathrop', -10), stop('s2', 2, 'delivery', 'Warrenton', 3), stop('s3', 3, 'delivery', 'Hillsboro', 20)];
const states = (load, now = NOW) => stopRows(load, now).map((r) => r.state);

test('3 stops, In transit, nothing checked off: stop 1 is next and not greyed', () => {
  const load = { status: 'in_transit', stops: three() };
  assert.equal(layoutFor(load), 'B');
  assert.equal(nextStopIndex(load, NOW), 0);
  assert.equal(completedNextIndex(load), 0);
  assert.deepEqual(states(load), ['next', 'upcoming', 'upcoming']);
});

test('the same load as Dispatched / Booked: identical rows (status never infers a check-off)', () => {
  for (const status of ['booked', 'dispatched', 'in_transit']) {
    assert.deepEqual(states({ status, stops: three() }), ['next', 'upcoming', 'upcoming'], status);
  }
});

test('check off in order: the highlight moves forward and never jumps back to an earlier stop', () => {
  let st = three();
  let load = { status: 'in_transit', stops: st };
  assert.deepEqual(states(load), ['next', 'upcoming', 'upcoming']);
  st = [done(st[0], -9), st[1], st[2]]; load = { status: 'in_transit', stops: st };
  assert.deepEqual(states(load), ['done', 'next', 'upcoming']);
  st = [st[0], done(st[1], 2), st[2]]; load = { status: 'in_transit', stops: st };
  assert.deepEqual(states(load), ['done', 'done', 'next']);
  assert.equal(nextStopIndex(load, NOW), 2);
});

test('QA repro: In transit first, stop 2 delivered before the pickup is checked: stop 1 stays pending, not "passed"', () => {
  const st = three();
  const load = { status: 'in_transit', stops: [st[0], done(st[1], 2), st[2]] };
  // the first unchecked stop in sequence is next; stop 2 shows done; nothing is greyed without a check
  assert.equal(nextStopIndex(load, NOW), 0);
  const rows = stopRows(load, NOW);
  assert.deepEqual(rows.map((r) => r.state), ['next', 'done', 'upcoming']);
  assert.ok(rows.filter((r) => r.state === 'done').every((r) => r.stop.completed_at), 'every muted row carries a ✓');
});

test('an unchecked stop is never muted, whatever the status and time', () => {
  for (const status of ['booked', 'dispatched', 'in_transit']) {
    for (const now of [NOW - 48 * H, NOW, NOW + 48 * H]) {
      const st = three();
      const load = { status, stops: [st[0], done(st[1], 2), st[2]] };
      for (const r of stopRows(load, now)) if (!r.stop.completed_at) assert.notEqual(r.state, 'done', `${status} ${r.index}`);
    }
  }
});

test('skipped stops count as checked off', () => {
  const st = three();
  const load = { status: 'in_transit', stops: [done(st[0], -9, 'skipped'), st[1], st[2]] };
  const rows = stopRows(load, NOW);
  assert.deepEqual(rows.map((r) => r.state), ['done', 'next', 'upcoming']);
  assert.equal(rows[0].skipped, true);
});

test('2-stop load: In transit with nothing checked → the pickup is next (Mark as picked up); after pickup → delivery', () => {
  const st = [stop('a', 1, 'pickup', 'Stockton', -10), stop('b', 2, 'delivery', 'Portland', 5)];
  const load = { status: 'in_transit', stops: st };
  assert.equal(layoutFor(load), 'A'); // the side-by-side card is unchanged
  assert.equal(routeStopsText(load), 'Stockton, OR → Portland, OR');
  assert.equal(nextStopIndex(load, NOW), 0);
  assert.equal(nextStopIndex({ status: 'in_transit', stops: [done(st[0], -9), st[1]] }, NOW), 1);
  assert.equal(nextStopIndex({ status: 'delivered', stops: [done(st[0], -9), done(st[1], 1)] }, NOW), 1, 'all done → last');
});

test('server plan is unchanged: checking off the pickup on an In transit load keeps the status; Undo → dispatched', () => {
  const st = three();
  const load = { status: 'in_transit', stops: st };
  const p = planStopAction(load, 's1', 'done', { now: iso(NOW) });
  assert.equal(p.status, null);
  assert.equal(p.stopPatch.completion, 'done');
  const picked = { status: 'in_transit', stops: [done(st[0], -1), st[1], st[2]] };
  assert.equal(planStopAction(picked, 's1', 'undo', { now: iso(NOW) }).status, 'dispatched');
});

test('stops without the completion columns (before the migration): the appointment guess still applies', () => {
  const legacy = three().map(({ completed_at, completion, completed_by, ...r }) => r);
  const load = { status: 'in_transit', stops: legacy };
  assert.equal(completedNextIndex(load), null);
  assert.equal(nextStopIndex(load, NOW), 1);
  assert.deepEqual(states(load), ['done', 'next', 'upcoming']);
});
