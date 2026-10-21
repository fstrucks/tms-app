// Home: overdue In transit loads (> 24 h past delivery) rank below current ones; "Delivered?" prompt; rate cons waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pickCurrentLoad, moreLine, upNext, isOverdueInTransit, OVERDUE_TRANSIT_MS, deliveredPromptMode, markDelivered,
  countRateconsWaiting, rateconsWaitingText,
} from '../../app/lib/homeCurrentLoad.js';

const NOW = Date.parse('2026-10-20T13:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const stop = (sequence, stop_type, at, end = null) => ({ id: `${stop_type}-${sequence}`, sequence, stop_type, city: 'Testville', state: 'TX', appointment_start: iso(at), appointment_end: iso(end), timezone: 'America/Chicago' });
const L = (id, status, puAt, delAt, delEnd = null) => ({ id, status, created_at: '2026-10-01T00:00:00Z', broker_load_number: `FAKE-${id}`, stops: [stop(1, 'pickup', puAt), stop(2, 'delivery', delAt, delEnd)] });

test('overdue: in transit and delivery appt (end, else start) more than 24 h ago', () => {
  assert.equal(isOverdueInTransit(L('a', 'in_transit', NOW - 200 * H, NOW - 25 * H), NOW), true);
  assert.equal(isOverdueInTransit(L('b', 'in_transit', NOW - 200 * H, NOW - 23 * H), NOW), false);
  assert.equal(isOverdueInTransit(L('c', 'in_transit', NOW - 200 * H, NOW - 30 * H, NOW - 20 * H), NOW), false); // window end wins
  assert.equal(isOverdueInTransit(L('d', 'in_transit', NOW - 200 * H, null), NOW), false); // undated never overdue
  assert.equal(isOverdueInTransit(L('e', 'dispatched', NOW - 200 * H, NOW - 100 * H), NOW), false);
  assert.equal(OVERDUE_TRANSIT_MS, 24 * H);
});

test("Marc's case: an old Oct 9 in transit load no longer beats a newer in transit load", () => {
  const old = L('old', 'in_transit', NOW - 11 * 24 * H, NOW - 8 * 24 * H);
  const cur = L('new', 'in_transit', NOW - 5 * H, NOW + 20 * H);
  const p = pickCurrentLoad([old, cur], NOW);
  assert.equal(p.load.id, 'new'); assert.equal(p.overdue, false);
  assert.equal(moreLine(p), '1 more in transit past delivery (mark as delivered?)');
  assert.deepEqual(upNext([old, cur], p.load, NOW).map((l) => l.id), ['old']);
});

test('dispatched beats overdue in transit; booked comes before overdue in Up next', () => {
  const old = L('old', 'in_transit', NOW - 11 * 24 * H, NOW - 8 * 24 * H);
  const disp = L('disp', 'dispatched', NOW + 2 * H, NOW + 30 * H);
  const bk = L('bk', 'booked', NOW + 40 * H, NOW + 60 * H);
  const p = pickCurrentLoad([old, disp, bk], NOW);
  assert.equal(p.load.id, 'disp');
  assert.deepEqual(upNext([old, disp, bk], p.load, NOW).map((l) => l.id), ['bk', 'old']);
});

test('only overdue in transit: it stays on the card with the Delivered? prompt; newer booked load in Up next', () => {
  const old = L('old', 'in_transit', NOW - 11 * 24 * H, NOW - 8 * 24 * H);
  const bk = L('bk', 'booked', NOW + 40 * H, NOW + 60 * H);
  const p = pickCurrentLoad([old, bk], NOW);
  assert.equal(p.load.id, 'old'); assert.equal(p.overdue, true); assert.equal(p.more, 0);
  assert.deepEqual(upNext([old, bk], p.load, NOW).map((l) => l.id), ['bk']);
});

test('mixed more line: current + overdue counted separately', () => {
  const loads = [L('a', 'in_transit', NOW - 2 * H, NOW + 9 * H), L('b', 'in_transit', NOW - 1 * H, NOW + 9 * H), L('o', 'in_transit', NOW - 300 * H, NOW - 200 * H)];
  const p = pickCurrentLoad(loads, NOW);
  assert.equal(p.load.id, 'a'); assert.equal(moreLine(p), '1 more on the road · 1 past delivery');
});

test('prompt mode by audience: owner button, management/dispatcher dispatch link, driver text', () => {
  assert.equal(deliveredPromptMode('owner', { id: 'x' }), 'button');
  assert.equal(deliveredPromptMode('member', { id: 'x', viewer_role: 'dispatcher' }), 'link');
  assert.equal(deliveredPromptMode('member', { id: 'x', viewer_role: 'driver' }), 'text');
});

function fakeSb(result) {
  const calls = [];
  const q = { calls, update(v) { calls.push(['update', v]); return q; }, eq(k, v) { calls.push(['eq', k, v]); return q; }, is(k, v) { calls.push(['is', k, v]); return q; },
    or(v) { calls.push(['or', v]); return Promise.resolve(result); }, select(c, o) { calls.push(['select', c, o]); return q; }, maybeSingle() { return Promise.resolve(result); } };
  return { calls, from(t) { calls.push(['from', t]); return q; } };
}

test('markDelivered uses the load page update (status delivered, guarded on in_transit)', async () => {
  const sb = fakeSb({ data: { status: 'delivered' }, error: null });
  assert.deepEqual(await markDelivered(sb, 'L1'), { ok: true });
  assert.deepEqual(sb.calls.slice(0, 5), [['from', 'loads'], ['update', { status: 'delivered' }], ['eq', 'id', 'L1'], ['eq', 'status', 'in_transit'], ['select', 'status', undefined]]);
  assert.equal((await markDelivered(fakeSb({ data: null, error: null }), 'L1')).ok, false);
  assert.equal((await markDelivered(fakeSb({ data: null, error: { code: '42501' } }), 'L1')).ok, false);
});

test('rate cons waiting: same filter as the Loads banner, excludes not_ratecon; text', async () => {
  const sb = fakeSb({ count: 3, error: null });
  assert.equal(await countRateconsWaiting(sb), 3);
  assert.ok(sb.calls.some((c) => c[0] === 'or' && c[1] === 'extraction_error.is.null,extraction_error.neq.not_ratecon'));
  assert.ok(sb.calls.some((c) => c[0] === 'eq' && c[1] === 'doc_type' && c[2] === 'rate_confirmation'));
  assert.ok(sb.calls.some((c) => c[0] === 'is' && c[1] === 'load_id'));
  assert.equal(await countRateconsWaiting(fakeSb({ count: null, error: { code: '42703' } })), 0);
  assert.equal(rateconsWaitingText(0), null);
  assert.equal(rateconsWaitingText(1), '1 rate con waiting for review');
  assert.equal(rateconsWaitingText(4), '4 rate cons waiting for review');
});

test('Home card wires the prompt and the waiting line to /documents', () => {
  const src = readFileSync(new URL('../../app/components/HomeCurrentLoad.js', import.meta.url), 'utf8');
  assert.match(src, /home-delivered-prompt/); assert.match(src, /Mark as delivered/);
  assert.match(src, /home-ratecons-waiting/); assert.match(src, /href="\/documents"/);
});
