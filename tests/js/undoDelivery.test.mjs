import test from 'node:test';
import assert from 'node:assert/strict';
import { planStopAction } from '../../app/lib/stopProgress.js';

const done = { completed_at: '2026-10-22T10:00:00Z', completion: 'done' };
const load = (status, a = done, b = done) => ({ status, stops: [{ id: 'p', sequence: 1, stop_type: 'pickup', ...a }, { id: 'd', sequence: 2, stop_type: 'delivery', ...b }] });

test('undo the delivery on a Delivered load → In transit', () => {
  const r = planStopAction(load('delivered'), 'd', 'undo');
  assert.equal(r.status, 'in_transit');
  assert.deepEqual(r.fromStatuses, ['delivered']);
  assert.equal(r.stopPatch.completed_at, null);
});

test('undo when only the first pickup is left marked on a Delivered load → Dispatched', () => {
  assert.equal(planStopAction(load('delivered', done, {}), 'p', 'undo').status, 'dispatched');
});

test('in-transit and invoiced loads keep the old rules', () => {
  assert.equal(planStopAction(load('in_transit', done, {}), 'p', 'undo').status, 'dispatched');
  assert.equal(planStopAction(load('in_transit'), 'd', 'undo').status, null);
  assert.equal(planStopAction(load('invoiced'), 'd', 'undo').status, null);
});
