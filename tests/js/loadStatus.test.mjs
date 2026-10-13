import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFetchedLoad, settleStatus } from '../../app/lib/loadStatus.js';

const cur = { id: 'a', status: 'dispatched', rate: 1 };
const fetched = { id: 'a', status: 'booked', rate: 2 };

test('a fetch that started before a status change keeps the newer status', () => {
  assert.deepEqual(mergeFetchedLoad(cur, fetched, true), { id: 'a', status: 'dispatched', rate: 2 });
});
test('a fresh fetch wins', () => {
  assert.equal(mergeFetchedLoad(cur, fetched, false), fetched);
  assert.equal(mergeFetchedLoad(null, fetched, true), fetched);
  assert.equal(mergeFetchedLoad({ id: 'b', status: 'paid' }, fetched, true), fetched);
});
test('successful save shows the new status immediately (DB row preferred)', () => {
  assert.equal(settleStatus(cur, { error: null, saved: { status: 'dispatched' }, prev: 'booked' }).status, 'dispatched');
  assert.equal(settleStatus(cur, { error: null, saved: null, prev: 'booked' }).status, 'dispatched');
});
test('failed save reverts to the previous status', () => {
  assert.equal(settleStatus(cur, { error: { code: '23514' }, saved: null, prev: 'booked' }).status, 'booked');
});
