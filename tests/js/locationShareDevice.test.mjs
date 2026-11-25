// Phone app background location: share-only sending key + /api/location-share/device-ping.
// Fake data only (Test Trucking Co / Other Fake Co). No network, no real database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  newDeviceKey, hashDeviceKey, readDeviceKey, deviceKeyExpiry, checkDeviceKeyRow, requestTooSoon, cleanPoint,
  parseDeviceBody, thinPoints, DEVICE_KEY_RE, DEVICE_KEY_MAX_AGE_MS, DEVICE_PING_REQUEST_GAP_MS, DEVICE_PING_MAX_POINTS,
  DEVICE_POINT_MAX_AGE_MS, PING_MIN_GAP_MS,
} from '../../app/lib/locationShareDevice.js';
import { EXPORT_TABLES, EXCLUDED_TABLES } from '../../app/lib/companyExport.js';
import { issueDeviceKey, recordDevicePings, stopShare, runLocationShareCron } from '../../app/lib/locationShareServer.js';
import * as KEY from '../../app/api/location-share/device-key/route.js';
import * as DPING from '../../app/api/location-share/device-ping/route.js';
import * as PING from '../../app/api/location-share/ping/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const OWNER = '00000000-0000-4000-8000-00000000aaaa';
const OTHER_OWNER = '00000000-0000-4000-8000-00000000eeee';
const DISP = '00000000-0000-4000-8000-00000000bbbb';
const DRV = '00000000-0000-4000-8000-00000000cccc';
const DRV2 = '00000000-0000-4000-8000-00000000dddd';
const DRV_O = '00000000-0000-4000-8000-00000000ffff';
const SID = '00000000-0000-4000-8000-0000000000a1';
const SID2 = '00000000-0000-4000-8000-0000000000a2';
const SID_O = '00000000-0000-4000-8000-0000000000a9';
const LOAD = '00000000-0000-4000-8000-0000000000f1';
const NOW = Date.parse('2026-11-25T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const live = (over = {}) => ({ id: SID, company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 8, started_at: iso(NOW - 3600e3), expires_at: iso(NOW + 3600e3), stopped_at: null, auto_stop_on_delivered: false, load_id: null, ...over });

function world(extra = {}) {
  return fakeSupabase({
    tables: {
      company_profiles: [{ id: COMPANY, owner_id: OWNER, legal_name: 'Test Trucking Co' }, { id: OTHER, owner_id: OTHER_OWNER, legal_name: 'Other Fake Co' }],
      company_members: [
        { profile_id: COMPANY, user_id: DISP, role: 'dispatcher' },
        { profile_id: COMPANY, user_id: DRV, role: 'driver' },
        { profile_id: COMPANY, user_id: DRV2, role: 'driver' },
        { profile_id: OTHER, user_id: DRV_O, role: 'driver' },
      ],
      loads: [{ id: LOAD, user_id: OWNER, assigned_driver_user_id: DRV, status: 'in_transit' }],
      location_shares: [live()],
      location_pings: [],
      location_share_latest: [],
      location_share_device_keys: [],
      ...extra,
    },
  });
}

const kctx = (userId = DRV, companyId = COMPANY) => ({ userId, companyId });
async function issued(db, at = NOW, shareId = SID, who = DRV, company = COMPANY) {
  const r = await issueDeviceKey(db, kctx(who, company), { share_id: shareId }, at);
  assert.ok(r.key, JSON.stringify(r));
  return r.key;
}
const pt = (lat, lng, t, extra = {}) => ({ lat, lng, recorded_at: iso(t), accuracy_m: 12, speed_mps: 25, heading: 90, ...extra });

// ---- pure helpers ----
test('key format: phsk_ + 43 base64url chars; only the SHA-256 hex is stored', () => {
  const k = newDeviceKey();
  assert.match(k, DEVICE_KEY_RE);
  assert.notEqual(newDeviceKey(), k);
  assert.match(hashDeviceKey(k), /^[0-9a-f]{64}$/);
  assert.equal(hashDeviceKey(k), hashDeviceKey(k));
});

test('the key is read only from the X-Share-Key header, and must match the format', () => {
  const k = newDeviceKey();
  const req = (h) => new Request('http://x/api', { method: 'POST', headers: h });
  assert.equal(readDeviceKey(req({ 'x-share-key': k })), k);
  assert.equal(readDeviceKey(req({ 'x-share-key': 'phsk_short' })), null);
  assert.equal(readDeviceKey(req({ authorization: `Bearer ${k}` })), null);
  assert.equal(readDeviceKey(new Request(`http://x/api?key=${k}`, { method: 'POST' })), null);
});

test('key expiry: the share’s end, capped at 7 days (until-off shares)', () => {
  assert.equal(deviceKeyExpiry(live(), NOW), iso(NOW + 3600e3));
  assert.equal(deviceKeyExpiry(live({ mode: 'until_off', expires_at: null, duration_hours: null }), NOW), iso(NOW + DEVICE_KEY_MAX_AGE_MS));
  assert.deepEqual(checkDeviceKeyRow(null, NOW), { ok: false, status: 401, code: 'bad_key' });
  assert.deepEqual(checkDeviceKeyRow({ expires_at: iso(NOW + 1), revoked_at: iso(NOW - 1) }, NOW), { ok: false, status: 401, code: 'bad_key' });
  assert.deepEqual(checkDeviceKeyRow({ expires_at: iso(NOW) }, NOW), { ok: false, status: 401, code: 'key_expired' });
  assert.equal(checkDeviceKeyRow({ expires_at: iso(NOW + 1) }, NOW).ok, true);
});

test('points: bad coordinates, far-future times, points before the share or older than a day are dropped; ms times accepted', () => {
  const s = live({ started_at: iso(NOW - 3 * 86400e3), expires_at: iso(NOW + 3600e3) });
  assert.equal(cleanPoint({ lat: 95, lng: 0 }, s, NOW), null);
  assert.equal(cleanPoint({ lat: 'x', lng: 0 }, s, NOW), null);
  assert.equal(cleanPoint(pt(41, -87, NOW + 10 * 60e3), s, NOW), null);
  assert.equal(cleanPoint(pt(41, -87, NOW + 30e3), s, NOW).t, NOW, 'small clock skew clamps to now');
  assert.equal(cleanPoint(pt(41, -87, NOW - DEVICE_POINT_MAX_AGE_MS - 1000), s, NOW), null);
  assert.equal(cleanPoint(pt(41, -87, NOW - 2 * 3600e3), live(), NOW), null, 'before the share started');
  const p = cleanPoint({ latitude: 41.5, longitude: -87.5, time: NOW - 5000, accuracy: 9, speed: -1, bearing: 400 }, s, NOW);
  assert.deepEqual(p, { lat: 41.5, lng: -87.5, accuracy_m: 9, speed_mps: null, heading: null, t: NOW - 5000 });
  assert.equal(parseDeviceBody({ points: Array.from({ length: DEVICE_PING_MAX_POINTS + 1 }, () => pt(41, -87, NOW)) }, s, NOW).status, 413);
  const one = parseDeviceBody({ lat: 41, lng: -87 }, s, NOW);
  assert.equal(one.points.length, 1);
});

test('thinning keeps the browser’s 20 s floor by each point’s own time', () => {
  const pts = [0, 5, 25, 30, 50].map((sec) => ({ t: NOW + sec * 1000 }));
  const r = thinPoints(pts, iso(NOW - 10_000));
  assert.deepEqual(r.keep.map((p) => (p.t - NOW) / 1000), [25, 50]);
  assert.equal(r.skipped, 3);
  assert.equal(PING_MIN_GAP_MS, 20_000);
  assert.equal(requestTooSoon(null, NOW), 0);
  assert.equal(requestTooSoon(iso(NOW - 4000), NOW), DEVICE_PING_REQUEST_GAP_MS - 4000);
});

// ---- issue ----
test('issue: only the sharer, only a live share, only in the active company; the plain key is never stored', async () => {
  const db = world();
  const r = await issueDeviceKey(db, kctx(), { share_id: SID }, NOW);
  assert.match(r.key, DEVICE_KEY_RE);
  assert.equal(r.expires_at, iso(NOW + 3600e3));
  const rows = db.db.location_share_device_keys;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key_hash, hashDeviceKey(r.key));
  assert.equal(JSON.stringify(rows).includes(r.key), false);
  assert.equal(rows[0].company_id, COMPANY);
  assert.equal((await issueDeviceKey(db, kctx(DISP), { share_id: SID }, NOW)).status, 403, 'office cannot mint a key for a driver');
  assert.equal((await issueDeviceKey(db, kctx(DRV2), { share_id: SID }, NOW)).status, 403, 'another driver cannot');
  assert.equal((await issueDeviceKey(db, kctx(DRV, OTHER), { share_id: SID }, NOW)).status, 403, 'wrong active company');
  assert.equal((await issueDeviceKey(db, kctx(), { share_id: 'nope' }, NOW)).status, 422);
  const ended = world({ location_shares: [live({ expires_at: iso(NOW - 1000) })] });
  const e = await issueDeviceKey(ended, kctx(), { share_id: SID }, NOW);
  assert.equal(e.status, 409);
  assert.equal(e.code, 'ended');
  assert.equal(ended.db.location_shares[0].stopped_reason, 'expired');
});

test('issue again: the earlier key is revoked (one working key per share)', async () => {
  const db = world();
  const k1 = await issued(db);
  const k2 = await issued(db, NOW + 1000);
  assert.notEqual(k1, k2);
  const liveKeys = db.db.location_share_device_keys.filter((k) => !k.revoked_at);
  assert.equal(liveKeys.length, 1);
  const r1 = await recordDevicePings(db, k1, pt(41.8, -87.6, NOW + 2000), NOW + 2000);
  assert.equal(r1.status, 401);
  assert.equal(r1.code, 'bad_key');
  assert.equal((await recordDevicePings(db, k2, pt(41.8, -87.6, NOW + 2000), NOW + 2000)).saved, 1);
});

// ---- device ping: auth ----
test('device ping auth: no key / malformed / unknown key → 401, and nothing is written', async () => {
  const db = world();
  const post = (headers, body = pt(41.8, -87.6, NOW)) => DPING.POST(new Request('http://x/api/location-share/device-ping', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), { deps: { sb: db, now: () => NOW } });
  for (const h of [{}, { 'x-share-key': 'phsk_bad' }, { 'x-share-key': newDeviceKey() }, { authorization: 'Bearer some-user-token' }]) {
    const res = await post(h);
    assert.equal(res.status, 401, JSON.stringify(h));
    assert.equal((await res.json()).code, 'bad_key');
  }
  assert.equal(db.db.location_pings.length, 0);
  const k = await issued(db);
  const ok = await post({ 'x-share-key': k });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.saved, 1);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

test('device key cannot be used as a sign-in token on the browser ping route', async () => {
  const db = world();
  const k = await issued(db);
  const res = await PING.POST(new Request('http://x/api/location-share/ping', { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ share_id: SID, lat: 41.8, lng: -87.6 }) }), {
    deps: { mkUserClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: { status: 401, message: 'invalid JWT' } }) }, from: () => { throw new Error('no db'); } }), sb: db, now: () => NOW, authRetryMs: 0 },
  });
  assert.equal(res.status, 401);
  assert.equal(db.db.location_pings.length, 0);
});

test('device-key route: needs a sign-in; returns the key once with no-store', async () => {
  const db = world();
  const uc = fakeSupabase({
    tables: {
      company_profiles: [{ id: COMPANY, owner_id: OWNER, legal_name: 'Test Trucking Co' }],
      company_members: [{ profile_id: COMPANY, user_id: DRV, role: 'driver', created_at: '2026-11-01T00:00:00Z' }],
    },
    user: { id: DRV }, role: 'driver',
  });
  const mk = (h) => new Request('http://x/api/location-share/device-key', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ share_id: SID }) });
  const none = await KEY.POST(mk({}), { deps: { mkUserClient: () => uc, sb: db, now: () => NOW } });
  assert.equal(none.status, 401);
  const res = await KEY.POST(mk({ authorization: 'Bearer t' }), { deps: { mkUserClient: () => uc, sb: db, now: () => NOW } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const j = await res.json();
  assert.match(j.key, DEVICE_KEY_RE);
  assert.equal(j.share_id, SID);
});

// ---- scoping ----
test('scoping: a key writes only to its own share; naming another share is refused; company_id comes from the share', async () => {
  const db = world({ location_shares: [live(), live({ id: SID2, user_id: DRV2 }), live({ id: SID_O, company_id: OTHER, user_id: DRV_O })] });
  const k = await issued(db);
  const other = await recordDevicePings(db, k, { share_id: SID_O, ...pt(41.8, -87.6, NOW) }, NOW);
  assert.equal(other.status, 403);
  assert.equal(other.code, 'wrong_share');
  const mate = await recordDevicePings(db, k, { share_id: SID2, ...pt(41.8, -87.6, NOW) }, NOW);
  assert.equal(mate.status, 403);
  assert.equal(db.db.location_pings.length, 0);
  const ok = await recordDevicePings(db, k, { points: [{ ...pt(41.8, -87.6, NOW), company_id: OTHER, share_id: SID_O }] }, NOW);
  assert.equal(ok.saved, 1);
  assert.equal(db.db.location_pings[0].share_id, SID);
  assert.equal(db.db.location_pings[0].company_id, COMPANY);
  assert.equal(db.db.location_share_latest[0].company_id, COMPANY);
  assert.equal(db.db.location_share_latest[0].user_id, DRV);
});

test('company isolation: a driver removed from the company mid-share → 403 not_member, key revoked, no point saved', async () => {
  const db = world();
  const k = await issued(db);
  db.db.company_members = db.db.company_members.filter((m) => m.user_id !== DRV);
  const r = await recordDevicePings(db, k, pt(41.8, -87.6, NOW), NOW);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'not_member');
  assert.ok(db.db.location_share_device_keys[0].revoked_at);
  assert.equal(db.db.location_pings.length, 0);
});

test('a key row that no longer matches its share (moved user/company) is refused and revoked', async () => {
  const db = world();
  const k = await issued(db);
  db.db.location_share_device_keys[0].company_id = OTHER;
  const r = await recordDevicePings(db, k, pt(41.8, -87.6, NOW), NOW);
  assert.equal(r.status, 403);
  assert.ok(db.db.location_share_device_keys[0].revoked_at);
});

// ---- expiry / end ----
test('expiry: past the share’s end → 409 ended, the share is stamped expired and the key revoked', async () => {
  const db = world();
  const k = await issued(db);
  const later = NOW + 2 * 3600e3;
  const r = await recordDevicePings(db, k, pt(41.8, -87.6, later), later);
  assert.equal(r.status, 401, 'key expired with the share');
  assert.equal(r.code, 'key_expired');
  // Key still inside its own window but the share was stopped (office) → ended
  const db2 = world();
  const k2 = await issued(db2);
  const stop = await stopShare(db2, { userId: DISP, role: 'dispatcher', companyId: COMPANY }, { shareId: SID, reason: 'office' }, NOW + 1000);
  assert.equal(stop.share.stopped_reason, 'office');
  assert.ok(db2.db.location_share_device_keys[0].revoked_at, 'stopping a share revokes its key');
  const r2 = await recordDevicePings(db2, k2, pt(41.8, -87.6, NOW + 2000), NOW + 2000);
  assert.equal(r2.status, 401);
});

test('expiry on read: share past expires_at but not stamped, key still in window (until-off cap) → 409 ended', async () => {
  const db = world();
  const k = await issued(db);
  db.db.location_share_device_keys[0].expires_at = iso(NOW + 5 * 3600e3);
  const r = await recordDevicePings(db, k, pt(41.8, -87.6, NOW + 2 * 3600e3), NOW + 2 * 3600e3);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'ended');
  assert.equal(db.db.location_shares[0].stopped_reason, 'expired');
  assert.ok(db.db.location_share_device_keys[0].revoked_at);
});

test('delivered load ends the share on the next device ping (same sweep as the browser)', async () => {
  const db = world({ location_shares: [live({ load_id: LOAD, auto_stop_on_delivered: true })] });
  const k = await issued(db);
  db.db.loads[0].status = 'delivered';
  const r = await recordDevicePings(db, k, pt(41.8, -87.6, NOW + 1000), NOW + 1000);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'ended');
  assert.equal(db.db.location_shares[0].stopped_reason, 'delivered');
});

test('until-off share: key lasts 7 days, then key_expired (the app asks for a new key when opened)', async () => {
  const db = world({ location_shares: [live({ mode: 'until_off', duration_hours: null, expires_at: null })] });
  const k = await issued(db);
  assert.equal(db.db.location_share_device_keys[0].expires_at, iso(NOW + DEVICE_KEY_MAX_AGE_MS));
  const r = await recordDevicePings(db, k, pt(41.8, -87.6, NOW + DEVICE_KEY_MAX_AGE_MS), NOW + DEVICE_KEY_MAX_AGE_MS);
  assert.equal(r.code, 'key_expired');
});

// ---- rate limiting ----
test('rate limit: one upload per key every 10 s → 429 slow_down with Retry-After; points 20 s apart within a batch', async () => {
  const db = world();
  const k = await issued(db);
  const post = (body, at) => DPING.POST(new Request('http://x/api', { method: 'POST', headers: { 'x-share-key': k, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { deps: { sb: db, now: () => at } });
  const first = await post({ points: [pt(41.8, -87.6, NOW - 50_000), pt(41.81, -87.6, NOW - 45_000), pt(41.82, -87.6, NOW - 20_000), pt(41.83, -87.6, NOW)] }, NOW);
  const j = await first.json();
  assert.equal(first.status, 200);
  assert.equal(j.saved, 3, 'the 5 s-apart point is thinned');
  assert.equal(j.skipped, 1);
  const soon = await post(pt(41.9, -87.6, NOW + 4000), NOW + 4000);
  assert.equal(soon.status, 429);
  assert.equal(soon.headers.get('retry-after'), '6');
  assert.equal((await soon.json()).code, 'slow_down');
  const close = await post(pt(41.9, -87.6, NOW + 12_000), NOW + 12_000);
  assert.equal((await close.json()).skipped, 1, 'next point under 20 s after the last stored one is skipped');
  const later = await post(pt(41.9, -87.6, NOW + 30_000), NOW + 30_000);
  assert.equal((await later.json()).saved, 1);
  assert.equal(db.db.location_pings.length, 4);
  const big = await post({ points: Array.from({ length: DEVICE_PING_MAX_POINTS + 1 }, (_, i) => pt(41, -87, NOW + 40_000 + i)) }, NOW + 60_000);
  assert.equal(big.status, 413);
});

test('queued points from a dead zone are saved in order; latest only moves forward', async () => {
  const db = world();
  const k = await issued(db);
  const r = await recordDevicePings(db, k, { points: [pt(41.9, -87.6, NOW - 60_000), pt(41.8, -87.6, NOW - 120_000)] }, NOW);
  assert.equal(r.saved, 2);
  assert.deepEqual(db.db.location_pings.map((p) => p.recorded_at), [iso(NOW - 120_000), iso(NOW - 60_000)]);
  assert.equal(db.db.location_share_latest[0].lat, 41.9);
  db.db.location_share_device_keys[0].last_used_at = null;
  db.db.location_share_latest[0].recorded_at = iso(NOW + 1000);
  await recordDevicePings(db, k, pt(40, -87, NOW), NOW);
  assert.equal(db.db.location_share_latest[0].lat, 41.9, 'an older point never overwrites a newer latest');
});

test('heartbeat from a parked phone touches updated_at only', async () => {
  const db = world({ location_share_latest: [{ share_id: SID, company_id: COMPANY, user_id: DRV, lat: 41.8, lng: -87.6, recorded_at: iso(NOW - 600e3), updated_at: iso(NOW - 600e3) }] });
  const k = await issued(db);
  const r = await recordDevicePings(db, k, { heartbeat: true, lat: 41.80001, lng: -87.60001, speed_mps: 0 }, NOW);
  assert.equal(r.heartbeat, true);
  assert.equal(db.db.location_pings.length, 0);
  assert.equal(db.db.location_share_latest[0].updated_at, iso(NOW));
});

// ---- housekeeping ----
test('cron deletes keys revoked or expired more than 7 days ago, keeps the rest', async () => {
  const old = iso(NOW - DEVICE_KEY_MAX_AGE_MS - 1000);
  const db = world({
    location_share_device_keys: [
      { id: 'k1', share_id: SID, key_hash: 'a'.repeat(64), expires_at: iso(NOW + 1000), revoked_at: old },
      { id: 'k2', share_id: SID, key_hash: 'b'.repeat(64), expires_at: old, revoked_at: null },
      { id: 'k3', share_id: SID, key_hash: 'c'.repeat(64), expires_at: iso(NOW + 1000), revoked_at: null },
    ],
  });
  const r = await runLocationShareCron(db, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(db.db.location_share_device_keys.map((k) => k.id), ['k3']);
});

test('migration not applied yet: issue and ping answer the setup message; stop and cron still work', async () => {
  const db = fakeSupabase({ tables: { ...world().db }, missing: ['location_share_device_keys'] });
  assert.equal((await issueDeviceKey(db, kctx(), { share_id: SID }, NOW)).setupNeeded, true);
  assert.equal((await recordDevicePings(db, newDeviceKey(), pt(41, -87, NOW), NOW)).setupNeeded, true);
  const s = await stopShare(db, { userId: DRV, role: 'driver', companyId: COMPANY }, { shareId: SID }, NOW);
  assert.equal(s.share.stopped_reason, 'user');
  assert.equal((await runLocationShareCron(db, NOW)).ok, true);
});

test('migration: additive only, new table with RLS and no grants to signed-in users; copy saved for review', () => {
  const sql = read('supabase/migrations/20261125000100_location_share_device_keys.sql');
  assert.match(sql, /ADDITIVE ONLY/);
  assert.match(sql, /NOT APPLIED/);
  assert.match(sql, /create table if not exists public\.location_share_device_keys/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.location_share_device_keys from public, anon, authenticated/);
  assert.equal(/create policy/i.test(sql), false, 'no policies: service role only');
  assert.equal(/\bdrop\s+(table|column|index|function|policy)\b/i.test(sql), false);
  assert.equal(/\bdelete\s+from\b|\btruncate\b|alter table public\.(?!location_share_device_keys)/i.test(sql), false);
  assert.match(sql, /key_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /where revoked_at is null/);
  // Key hashes never leave the server in a company export.
  assert.ok(EXCLUDED_TABLES.location_share_device_keys);
  assert.equal(EXPORT_TABLES.some((t) => t.table === 'location_share_device_keys'), false);

});

test('web app unchanged: the browser sharing bar still uses the signed-in ping route and never asks for a device key', () => {
  const bar = read('app/components/LocationShareBar.js');
  assert.match(bar, /\/api\/location-share\/ping/);
  assert.equal(/device-key|device-ping/.test(bar), false);
  const route = read('app/api/location-share/device-ping/route.js');
  assert.equal(/console\.(log|info|error)/.test(route), false, 'no logging on the device route');
});
