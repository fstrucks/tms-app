// Home "Current load" card (Marc's hybrid, Oct 18 2026) + per-load "Show rate to driver" (20261018000600).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pickCurrentLoad, moreLine, upNext, eligibleBooked, layoutFor, isMultiStop, routeLabel, nextStopIndex, countdown,
  fmtDuration, pickupNumbers, pickupNumberText, PICKUP_FALLBACK, cardAudience, canShowRate, rateText,
  fetchHomeLoads, isMissingFunction, HOME_LOAD_COLS, CARD_STATUSES,
} from '../../app/lib/homeCurrentLoad.js';
import { currentInTransit } from '../../app/lib/loadTabs.js';
import { buildNewLoad, EMPTY_NEW_LOAD } from '../../app/lib/loadNew.js';
import { isMissingDriverColumn, saveDriverSettings, fetchDriverChoices } from '../../app/lib/loadDriver.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const stop = (sequence, stop_type, city, at, extra = {}) => ({ id: `${city}-${sequence}`, sequence, stop_type, city, state: 'TX', company_name: `${city} Co (FAKE)`, address_line1: '1 Test Rd', zip: '75001', appointment_start: at == null ? null : iso(at), timezone: 'America/Chicago', ...extra });
const L = (id, status, puAt, delAt, extra = {}) => ({ id, status, created_at: '2026-10-01T00:00:00Z', broker_name: 'Demo Broker (FAKE)', broker_load_number: `FAKE-${id}`, notes: null,
  stops: [stop(2, 'delivery', `D${id}`, delAt), stop(1, 'pickup', `P${id}`, puAt)], ...extra });

test('selection: in transit beats dispatched even with a later pickup', () => {
  const loads = [L('d', 'dispatched', NOW - 5 * H, NOW), L('t', 'in_transit', NOW + 5 * H, NOW + 9 * H)];
  const p = pickCurrentLoad(loads, NOW);
  assert.equal(p.load.id, 't'); assert.equal(p.kind, 'current'); assert.equal(p.more, 0);
});

test('selection: several in transit → same load as the Loads page "On the road" bar, plus "N more on the road"', () => {
  const loads = [L('a', 'in_transit', NOW + 2 * H, NOW + 9 * H), L('b', 'in_transit', NOW - 2 * H, NOW + 9 * H), L('c', 'in_transit', null, null)];
  const p = pickCurrentLoad(loads, NOW);
  assert.equal(p.load.id, 'b');
  assert.equal(p.load, currentInTransit(loads));
  assert.equal(moreLine(p), '2 more on the road');
});

test('selection: dispatched next, earliest pickup, "N more dispatched"', () => {
  const p = pickCurrentLoad([L('x', 'dispatched', NOW + 9 * H, NOW + 20 * H), L('y', 'dispatched', NOW + 1 * H, NOW + 20 * H), L('z', 'booked', NOW, NOW)], NOW);
  assert.equal(p.load.id, 'y'); assert.equal(moreLine(p), '1 more dispatched');
});

test('selection: booked → "Next load"; stale (> 24 h past) skipped; undated only when none dated; delivered etc. never', () => {
  const loads = [L('old', 'booked', NOW - 30 * H, NOW), L('soon', 'booked', NOW + 3 * H, NOW + 9 * H), L('later', 'booked', NOW + 30 * H, NOW + 40 * H),
    L('nodate', 'booked', null, null), L('del', 'delivered', NOW, NOW), L('paid', 'paid', NOW, NOW), L('can', 'cancelled', NOW, NOW)];
  const p = pickCurrentLoad(loads, NOW);
  assert.equal(p.kind, 'next'); assert.equal(p.load.id, 'soon');
  assert.deepEqual(eligibleBooked(loads, NOW).map((l) => l.id), ['soon', 'later']);
  const u = [L('n1', 'booked', null, null, { created_at: '2026-10-01T00:00:00Z' }), L('n2', 'booked', null, null, { created_at: '2026-10-05T00:00:00Z' })];
  assert.equal(pickCurrentLoad(u, NOW).load.id, 'n2');
  assert.equal(pickCurrentLoad([L('del', 'delivered', NOW, NOW)], NOW).kind, 'empty');
  assert.equal(pickCurrentLoad([], NOW).kind, 'empty');
});

test('Up next: next 2 booked, never the load on the card', () => {
  const loads = [L('t', 'in_transit', NOW, NOW), L('b1', 'booked', NOW + 1 * H, NOW), L('b2', 'booked', NOW + 2 * H, NOW), L('b3', 'booked', NOW + 3 * H, NOW)];
  assert.deepEqual(upNext(loads, loads[0], NOW).map((l) => l.id), ['b1', 'b2']);
  const onlyBooked = loads.slice(1);
  const p = pickCurrentLoad(onlyBooked, NOW);
  assert.deepEqual(upNext(onlyBooked, p.load, NOW).map((l) => l.id), ['b2', 'b3']);
});

test('layout: A for one pickup + one drop, B for more than two stops', () => {
  const a = L('a', 'in_transit', NOW, NOW);
  assert.equal(layoutFor(a), 'A'); assert.equal(isMultiStop(a), false);
  const b = { ...a, stops: [...a.stops, stop(3, 'delivery', 'Dallas', NOW + 20 * H)] };
  assert.equal(layoutFor(b), 'B');
  assert.equal(routeLabel(b), 'Pa, TX → Dallas, TX');
});

test('Option B next stop: first stop before in transit; then first not-yet-passed stop; else the last', () => {
  const st = [stop(1, 'pickup', 'A', NOW - 10 * H), stop(2, 'pickup', 'B', NOW - 5 * H), stop(3, 'delivery', 'C', NOW + 4 * H), stop(4, 'delivery', 'D', NOW + 9 * H)];
  assert.equal(nextStopIndex({ status: 'dispatched', stops: st }, NOW), 0);
  assert.equal(nextStopIndex({ status: 'in_transit', stops: st }, NOW), 2);
  assert.equal(nextStopIndex({ status: 'in_transit', stops: st }, NOW - 4 * H), 1, 'B within the 2 h grace is still next');
  assert.equal(nextStopIndex({ status: 'in_transit', stops: st }, NOW + 20 * H), 3, 'all passed → last stop (shows late)');
});

test('countdown: normal, amber under 2 h, window open, red once late', () => {
  assert.deepEqual(countdown({ appointment_start: iso(NOW + 14 * H) }, NOW), { text: 'Due in 14 h', tone: 'normal' });
  assert.deepEqual(countdown({ appointment_start: iso(NOW + 90 * 60000) }, NOW), { text: 'Due in 1 h 30 min', tone: 'amber' });
  assert.equal(countdown({ appointment_start: iso(NOW + 2 * H) }, NOW).tone, 'normal');
  assert.equal(countdown({ appointment_start: iso(NOW - H), appointment_end: iso(NOW + H) }, NOW).tone, 'amber');
  assert.deepEqual(countdown({ appointment_start: iso(NOW - 35 * 60000) }, NOW), { text: 'Late by 35 min', tone: 'red' });
  assert.equal(countdown({ appointment_start: null }, NOW), null);
  assert.equal(fmtDuration(50 * H), '2 d 2 h');
});

test('pickup number: stops.pickup_number, else the "Refs:" line, else the fallback', () => {
  assert.deepEqual(pickupNumbers('Driver must call\nRefs: PO 5512, PU# 48211-FAKE, BOL 7'), ['48211-FAKE']);
  assert.deepEqual(pickupNumbers('Refs: Pickup #: A-12; P/U 889; Pickup Number 55'), ['A-12', '889', '55']);
  assert.deepEqual(pickupNumbers('Refs: PURCHASE 1, PO 9'), []);
  assert.deepEqual(pickupNumbers('PU# 1 (not on a Refs line)'), []);
  const l = L('a', 'booked', NOW, NOW, { notes: 'Refs: PU 777' });
  const pu = l.stops.find((s) => s.stop_type === 'pickup');
  assert.equal(pickupNumberText(l, pu), 'Pickup # 777');
  assert.equal(pickupNumberText({ ...l, notes: 'Refs: PO 1' }, pu), PICKUP_FALLBACK);
  assert.equal(PICKUP_FALLBACK, 'Pickup # — see rate con');
  assert.equal(pickupNumberText(l, { ...pu, pickup_number: 'PU-OWN' }), 'Pickup # PU-OWN');
  const two = { notes: 'Refs: PU 1, PU 2', stops: [stop(1, 'pickup', 'A', NOW), stop(2, 'pickup', 'B', NOW), stop(3, 'delivery', 'C', NOW)] };
  assert.equal(pickupNumberText(two, two.stops[1]), 'Pickup # 2');
});

test('audience: owner, solo account, member', () => {
  assert.equal(cardAudience('u', []), 'owner');
  assert.equal(cardAudience('u', [{ user_id: 'u', role: 'owner' }]), 'owner');
  assert.equal(cardAudience('u', [{ user_id: 'u', role: 'driver' }]), 'member');
  assert.equal(cardAudience('u', [{ user_id: 'u', role: 'driver' }, { user_id: 'u', role: 'owner' }]), 'owner');
});

test('rate on the card: exactly what the server allowed', () => {
  assert.equal(canShowRate({ rate: 1800, can_see_rate: false }, 'member'), false);
  assert.equal(canShowRate({ rate: 1800, can_see_rate: true }, 'member'), true);
  assert.equal(canShowRate({ rate: null, can_see_rate: true }, 'member'), false);
  assert.equal(canShowRate({ rate: 1800 }, 'owner'), true, 'owner fallback select (before the migration)');
  assert.equal(canShowRate({ rate: 1800 }, 'member'), false);
  assert.equal(rateText({ rate: 1800, rate_per_mile: 2.5 }), 'Rate $1,800.00 · $2.50/mi');
});

const fakeSb = ({ rpc, select }) => ({
  rpc: async (name, args) => rpc(name, args),
  from: () => { const q = { _cols: null, select(c) { q._cols = c; return q; }, in() { return q; }, order() { return select(q._cols); } }; return q; },
});

test('fetchHomeLoads: visible_loads() when present; owner fallback when the function is missing; real errors surface', async () => {
  let r = await fetchHomeLoads(fakeSb({ rpc: (n, a) => { assert.equal(n, 'visible_loads'); assert.deepEqual(a.p_statuses, CARD_STATUSES); return { data: [{ id: 1 }], error: null }; }, select: () => assert.fail() }));
  assert.deepEqual(r, { loads: [{ id: 1 }], viaRpc: true, error: null });
  r = await fetchHomeLoads(fakeSb({ rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.visible_loads' } }), select: (c) => { assert.equal(c, HOME_LOAD_COLS); return { data: [{ id: 2 }], error: null }; } }));
  assert.deepEqual(r, { loads: [{ id: 2 }], viaRpc: false, error: null });
  r = await fetchHomeLoads(fakeSb({ rpc: () => ({ data: null, error: { code: '500', message: 'boom' } }), select: () => assert.fail() }));
  assert.equal(r.loads, null); assert.ok(r.error);
  assert.equal(isMissingFunction({ code: '42883' }), true);
});

test('new load: driver, show-rate and pickup # are sent only when set', () => {
  const base = { ...EMPTY_NEW_LOAD, rate: '1000', pu_city: 'A', pu_state: 'TX', del_city: 'B', del_state: 'TX' };
  let b = buildNewLoad(base, { userId: 'u' });
  assert.ok(!('assigned_driver_user_id' in b.load) && !('show_rate_to_driver' in b.load) && !('pickup_number' in b.stops[0]));
  b = buildNewLoad({ ...base, driver_user_id: 'd1', show_rate_to_driver: true, pu_pickup_number: ' PU-9 ' }, { userId: 'u' });
  assert.equal(b.load.assigned_driver_user_id, 'd1'); assert.equal(b.load.show_rate_to_driver, true); assert.equal(b.stops[0].pickup_number, 'PU-9');
  assert.ok(!('pickup_number' in b.stops[1]));
});

test('driver settings helpers: RPC names, error mapping, missing migration', async () => {
  const sb = { rpc: async (n, a) => (n === 'set_load_driver_settings' ? (assert.deepEqual(a, { p_load: 'L', p_driver: null, p_show: true }), { data: null, error: { message: 'not_allowed' } }) : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) };
  const s = await saveDriverSettings(sb, 'L', { driverId: '', showRate: true });
  assert.equal(s.ok, false); assert.match(s.error, /Only the owner, management or a dispatcher/);
  assert.deepEqual(await fetchDriverChoices(sb), { available: false, choices: [], error: null });
  assert.equal(isMissingDriverColumn({ code: '42703', message: 'column "show_rate_to_driver" does not exist' }), true);
});

const card = readFileSync(new URL('../../app/components/HomeCurrentLoad.js', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../../supabase/migrations/20261018000600_load_driver_rate_members.sql', import.meta.url), 'utf8');

test('card source: members get no owner-only links; rate only through canShowRate; no card for members before the migration', () => {
  assert.match(card, /\{owner && \(\s*<div[^>]*>\s*<Link href=\{`\/loads\/\$\{load\.id\}`\}/);
  assert.match(card, /canShowRate\(load, audience\) &&/);
  assert.match(card, /who === 'member' && !res\.viaRpc \? 'hidden'/);
  assert.match(card, /if \(audience === 'hidden'\) return null;/);
  assert.doesNotMatch(card, /rate_per_mile|\.rate\b/, 'the card never reads rate fields itself');
});

test('migration: additive, own-row RLS untouched, rate masked for drivers, writes role-checked', () => {
  assert.doesNotMatch(mig, /drop policy|create policy|drop table|drop column|delete from|truncate/i);
  assert.match(mig, /show_rate_to_driver boolean not null default false/);
  assert.match(mig, /assigned_driver_user_id uuid references auth\.users\(id\) on delete set null/);
  assert.match(mig, /add column if not exists pickup_number text/);
  assert.match(mig, /'rate', case when r\.can_see_rate then r\.rate end/);
  assert.match(mig, /'rate_per_mile', case when r\.can_see_rate then r\.rate_per_mile end/);
  assert.match(mig, /v\.viewer_role <> 'driver' or v\.assigned_driver_user_id = auth\.uid\(\)/);
  assert.match(mig, /v_role not in \('owner', 'management', 'dispatcher'\)/);
  for (const f of ['visible_loads(text[], uuid)', 'set_load_driver_settings(uuid, uuid, boolean)', 'load_driver_choices(uuid)', 'load_viewer_role(uuid)'])
    assert.ok(mig.includes(`revoke execute on function public.${f} from public, anon;`), f);
});
