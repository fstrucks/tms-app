// Location sharing Phase 1. Fake data only (Test Trucking Co). Never calls a real database or routing service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  DURATION_HOURS, DEFAULT_DURATION_HOURS, PING_MIN_GAP_MS, PING_MAX_AGE_DAYS, PING_AFTER_END_DAYS,
  validateStart, isShareLive, expiryPatch, viewShare, canStartShare, canStopShare, canReadShare,
  canStartForOthers, defaultAutoStopOnDelivered, shouldRemind, pingAllowed, shouldPurgePing,
  shouldPurgeLatest, untilLabel, cronAuthorized, intervalSql, REMIND_AFTER_MS, CONSENT_FOREGROUND,
  normalizeShareInsert, guardShareUpdate, fillPingFromShare, SHARE_LOCK_COLS,
} from '../../app/lib/locationShare.js';
import {
  startShare, stopShare, recordPing, officeShares, stopSharesForDeliveredLoad,
  expireDueShares, purgeOldPings, runLocationShareCron, markReminded, cronLocationShares,
} from '../../app/lib/locationShareServer.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const OWNER = '00000000-0000-4000-8000-00000000aaaa';
const DISP = '00000000-0000-4000-8000-00000000bbbb';
const DRV = '00000000-0000-4000-8000-00000000cccc';
const DRV2 = '00000000-0000-4000-8000-00000000dddd';
const LOAD = '00000000-0000-4000-8000-0000000000f1';
const NOW = Date.parse('2026-11-17T14:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const ctx = (userId, role) => ({ userId, role, companyId: COMPANY, ownerId: OWNER });

function world(rows = {}) {
  return fakeSupabase({
    tables: {
      company_profiles: [{ id: COMPANY, owner_id: OWNER, legal_name: 'Test Trucking Co' }],
      company_members: [
        { profile_id: COMPANY, user_id: DISP, role: 'dispatcher' },
        { profile_id: COMPANY, user_id: DRV, role: 'driver' },
        { profile_id: COMPANY, user_id: DRV2, role: 'driver' },
      ],
      loads: [{ id: LOAD, user_id: OWNER, assigned_driver_user_id: DRV, status: 'in_transit', broker_load_number: 'TEST-1', broker_name: 'Fake Broker', created_at: '2026-11-16T00:00:00Z' }],
      drivers: [{ user_id: OWNER, auth_user_id: DRV, name: 'Test Driver' }],
      location_shares: [],
      location_pings: [],
      location_share_latest: [],
      ...(rows.tables || {}),
    },
    unique: { location_shares: [{ cols: ['user_id'], where: (r) => !r.stopped_at }] },
  });
}

// ---- durations ----
test('durations: 1/4/8/24 plus until-off, default 8 hours', () => {
  assert.deepEqual(DURATION_HOURS, [1, 4, 8, 24]);
  assert.equal(DEFAULT_DURATION_HOURS, 8);
  const d = validateStart({}, { now: NOW });
  assert.equal(d.mode, 'timed');
  assert.equal(d.duration_hours, 8);
  assert.equal(d.expires_at, iso(NOW + 8 * 3600e3));
  const h1 = validateStart({ duration_hours: 1 }, { now: NOW });
  assert.equal(h1.expires_at, iso(NOW + 3600e3));
  const off = validateStart({ mode: 'until_off' }, { now: NOW });
  assert.equal(off.mode, 'until_off');
  assert.equal(off.expires_at, null);
  assert.equal(off.duration_hours, null);
  assert.equal(validateStart({ duration_hours: 3 }, { now: NOW }).status, 422);
});

test('auto-stop on delivery defaults on only when a load is chosen', () => {
  assert.equal(defaultAutoStopOnDelivered(null), false);
  assert.equal(defaultAutoStopOnDelivered(LOAD), true);
  assert.equal(validateStart({ duration_hours: 8 }, { now: NOW }).auto_stop_on_delivered, false);
  assert.equal(validateStart({ duration_hours: 8, load_id: LOAD }, { now: NOW }).auto_stop_on_delivered, true);
  assert.equal(validateStart({ duration_hours: 8, load_id: LOAD, auto_stop_on_delivered: false }, { now: NOW }).auto_stop_on_delivered, false);
});

// ---- expiry on read ----
test('expiry on read: a timed share past expires_at is not live even if stopped_at is still empty', () => {
  const share = { id: 's1', expires_at: iso(NOW - 1000), stopped_at: null, mode: 'timed' };
  assert.equal(isShareLive(share, NOW), false);
  assert.deepEqual(expiryPatch(share, NOW), { stopped_at: iso(NOW), stopped_reason: 'expired', stopped_by: null });
  assert.equal(viewShare(share, NOW).live, false);
  const live = { id: 's2', expires_at: iso(NOW + 1000), stopped_at: null };
  assert.equal(isShareLive(live, NOW), true);
  assert.equal(expiryPatch(live, NOW), null);
  const off = { id: 's3', expires_at: null, stopped_at: null, mode: 'until_off' };
  assert.equal(isShareLive(off, NOW), true);
});

test('expireDueShares stamps expired rows so a late cron never leaves them visible', async () => {
  const db = world({
    tables: {
      location_shares: [
        { id: '00000000-0000-4000-8000-0000000000a1', company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 1, started_at: iso(NOW - 2 * 3600e3), expires_at: iso(NOW - 60e3), stopped_at: null },
        { id: '00000000-0000-4000-8000-0000000000a2', company_id: COMPANY, user_id: DRV2, mode: 'until_off', duration_hours: null, started_at: iso(NOW - 2 * 3600e3), expires_at: null, stopped_at: null },
      ],
    },
  });
  const r = await expireDueShares(db, NOW);
  assert.equal(r.n, 1);
  assert.equal(db.db.location_shares[0].stopped_reason, 'expired');
  assert.equal(db.db.location_shares[1].stopped_at, null);
});

// ---- permissions ----
test('office can stop a driver’s share and cannot start one for them; other drivers cannot read', () => {
  const share = { id: 's1', user_id: DRV, company_id: COMPANY };
  assert.equal(canStartShare({ actorId: DRV, targetUserId: DRV }), true);
  assert.equal(canStartShare({ actorId: DISP, targetUserId: DRV }), false);
  assert.equal(canStartShare({ actorId: OWNER, targetUserId: DRV }), false);
  assert.equal(canStartForOthers(), false);
  assert.equal(canStopShare({ actorId: DRV, actorRole: 'driver', actorCompanyId: COMPANY, share }), true);
  assert.equal(canStopShare({ actorId: DISP, actorRole: 'dispatcher', actorCompanyId: COMPANY, share }), true);
  assert.equal(canStopShare({ actorId: OWNER, actorRole: 'owner', actorCompanyId: COMPANY, share }), true);
  assert.equal(canStopShare({ actorId: DRV2, actorRole: 'driver', actorCompanyId: COMPANY, share }), false);
  assert.equal(canReadShare({ actorId: DRV2, actorRole: 'driver', actorCompanyId: COMPANY, share }), false);
  assert.equal(canReadShare({ actorId: DISP, actorRole: 'dispatcher', actorCompanyId: COMPANY, share }), true);
  assert.equal(canReadShare({ actorId: DRV2, actorRole: 'driver', actorCompanyId: COMPANY, share: { ...share, user_id: DRV2 } }), true);
});

test('startShare refuses a user_id for someone else; only the caller is stored', async () => {
  const db = world();
  const denied = await startShare(db, ctx(DISP, 'dispatcher'), { duration_hours: 8, user_id: DRV }, NOW);
  assert.equal(denied.status, 403);
  assert.equal(db.db.location_shares.length, 0);
  const ok = await startShare(db, ctx(DRV, 'driver'), { duration_hours: 8, user_id: DRV }, NOW);
  assert.equal(ok.share.user_id, DRV);
  assert.equal(ok.share.duration_hours, 8);
  assert.equal(ok.share.live, true);
});

test('stopShare: office stop records stopped_reason office and stopped_by; a second driver is refused', async () => {
  const sid = '00000000-0000-4000-8000-0000000000a1';
  const db = world({
    tables: {
      location_shares: [{
        id: sid, company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 8,
        started_at: iso(NOW - 1000), expires_at: iso(NOW + 8 * 3600e3), stopped_at: null,
      }],
    },
  });
  const no = await stopShare(db, ctx(DRV2, 'driver'), { shareId: sid }, NOW);
  assert.equal(no.status, 403);
  assert.equal(db.db.location_shares[0].stopped_at, null);
  const ok = await stopShare(db, ctx(DISP, 'dispatcher'), { shareId: sid, reason: 'office' }, NOW);
  assert.equal(ok.share.stopped_reason, 'office');
  assert.equal(ok.share.stopped_by, DISP);
  assert.equal(ok.share.live, false);
});

test('officeShares lists a live driver and hides expired rows; a driver role is refused', async () => {
  const liveId = '00000000-0000-4000-8000-0000000000a1';
  const deadId = '00000000-0000-4000-8000-0000000000a2';
  const db = world({
    tables: {
      location_shares: [
        { id: liveId, company_id: COMPANY, user_id: DRV, load_id: LOAD, mode: 'timed', duration_hours: 8, started_at: iso(NOW - 1000), expires_at: iso(NOW + 3600e3), stopped_at: null },
        { id: deadId, company_id: COMPANY, user_id: DRV2, mode: 'timed', duration_hours: 1, started_at: iso(NOW - 2 * 3600e3), expires_at: iso(NOW - 1000), stopped_at: null },
      ],
      location_share_latest: [{ share_id: liveId, company_id: COMPANY, user_id: DRV, lat: 41.8, lng: -87.6, recorded_at: iso(NOW - 30e3) }],
    },
  });
  const forbidden = await officeShares(db, ctx(DRV, 'driver'), NOW);
  assert.equal(forbidden.status, 403);
  const list = await officeShares(db, ctx(DISP, 'dispatcher'), NOW);
  assert.equal(list.shares.length, 1);
  assert.equal(list.shares[0].id, liveId);
  assert.equal(list.shares[0].label, 'Test Driver');
  assert.equal(list.shares[0].load_ref, '#TEST-1 · Fake Broker');
  assert.equal(list.shares[0].lat, 41.8);
  assert.equal(db.db.location_shares.find((s) => s.id === deadId).stopped_reason, 'expired');
});

// ---- delivered auto-stop ----
test('delivered auto-stop ends only shares for that load with the flag on', async () => {
  const a = '00000000-0000-4000-8000-0000000000a1';
  const b = '00000000-0000-4000-8000-0000000000a2';
  const other = '00000000-0000-4000-8000-0000000000a3';
  const db = world({
    tables: {
      location_shares: [
        { id: a, company_id: COMPANY, user_id: DRV, load_id: LOAD, auto_stop_on_delivered: true, mode: 'until_off', started_at: iso(NOW - 1000), expires_at: null, stopped_at: null },
        { id: b, company_id: COMPANY, user_id: DRV2, load_id: other, auto_stop_on_delivered: true, mode: 'until_off', started_at: iso(NOW - 1000), expires_at: null, stopped_at: null },
      ],
    },
  });
  const r = await stopSharesForDeliveredLoad(db, LOAD, NOW);
  assert.equal(r.n, 1);
  assert.equal(db.db.location_shares[0].stopped_reason, 'delivered');
  assert.equal(db.db.location_shares[1].stopped_at, null);
});

test('startShare with a load turns auto-stop on by default', async () => {
  const db = world();
  const r = await startShare(db, ctx(DRV, 'driver'), { duration_hours: 4, load_id: LOAD }, NOW);
  assert.equal(r.share.auto_stop_on_delivered, true);
  assert.equal(r.share.load_id, LOAD);
  assert.equal(r.share.duration_hours, 4);
});

// ---- reminder ----
test('until-off reminder is once per 24 hours, and never for timed shares', () => {
  const started = iso(NOW - REMIND_AFTER_MS - 1000);
  const off = { mode: 'until_off', started_at: started, expires_at: null, stopped_at: null, last_reminded_at: null };
  assert.equal(shouldRemind(off, NOW), true);
  assert.equal(shouldRemind({ ...off, last_reminded_at: iso(NOW - 1000) }, NOW), false);
  assert.equal(shouldRemind({ ...off, last_reminded_at: iso(NOW - REMIND_AFTER_MS - 1) }, NOW), true);
  assert.equal(shouldRemind({ ...off, started_at: iso(NOW - 1000) }, NOW), false);
  assert.equal(shouldRemind({ ...off, mode: 'timed', expires_at: iso(NOW + 3600e3) }, NOW), false);
});

test('markReminded records last_reminded_at so the nudge stays quiet for a day', async () => {
  const sid = '00000000-0000-4000-8000-0000000000a1';
  const db = world({
    tables: {
      location_shares: [{ id: sid, company_id: COMPANY, user_id: DRV, mode: 'until_off', started_at: iso(NOW - 2 * REMIND_AFTER_MS), expires_at: null, stopped_at: null, last_reminded_at: null }],
    },
  });
  const r = await markReminded(db, ctx(DRV, 'driver'), sid, NOW);
  assert.equal(r.ok, true);
  assert.equal(shouldRemind(r.share, NOW), false);
  assert.equal(r.share.last_reminded_at, iso(NOW));
});

// ---- ping rate floor ----
test('ping rate floor: a second ping sooner than 20s is skipped, not saved', async () => {
  const sid = '00000000-0000-4000-8000-0000000000a1';
  const db = world({
    tables: {
      location_shares: [{ id: sid, company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 8, started_at: iso(NOW - 1000), expires_at: iso(NOW + 8 * 3600e3), stopped_at: null }],
    },
  });
  assert.equal(PING_MIN_GAP_MS, 20_000);
  assert.equal(pingAllowed(iso(NOW - 5_000), NOW), false);
  assert.equal(pingAllowed(iso(NOW - 20_000), NOW), true);
  const a = await recordPing(db, ctx(DRV, 'driver'), { share_id: sid, lat: 41.8, lng: -87.6 }, NOW);
  assert.equal(a.ok, true);
  const b = await recordPing(db, ctx(DRV, 'driver'), { share_id: sid, lat: 41.81, lng: -87.61 }, NOW + 5_000);
  assert.equal(b.skipped, 'rate');
  assert.equal(db.db.location_pings.length, 1);
  const ended = await recordPing(db, ctx(DRV, 'driver'), { share_id: sid, lat: 41.8, lng: -87.6 }, NOW + 9 * 3600e3);
  assert.equal(ended.code, 'ended');
});

// ---- retention ----
test('retention cutoffs: 30 days, or 7 days after the share ends (easy to change)', () => {
  assert.equal(PING_MAX_AGE_DAYS, 30);
  assert.equal(PING_AFTER_END_DAYS, 7);
  assert.equal(intervalSql(30), '30 days');
  const live = { stopped_at: null, expires_at: iso(NOW + 3600e3) };
  const old = { recorded_at: iso(NOW - 31 * 24 * 3600e3) };
  const recent = { recorded_at: iso(NOW - 10 * 24 * 3600e3) };
  assert.equal(shouldPurgePing(old, live, NOW), true);
  assert.equal(shouldPurgePing(recent, live, NOW), false);
  const ended = { stopped_at: iso(NOW - 8 * 24 * 3600e3), expires_at: null };
  assert.equal(shouldPurgePing(recent, ended, NOW), true);
  assert.equal(shouldPurgeLatest(ended, NOW), true);
  assert.equal(shouldPurgeLatest({ stopped_at: iso(NOW - 2 * 24 * 3600e3) }, NOW), false);
});

test('purgeOldPings deletes aged points and ended shares past the after-end window', async () => {
  const liveId = '00000000-0000-4000-8000-0000000000a1';
  const deadId = '00000000-0000-4000-8000-0000000000a2';
  const db = world({
    tables: {
      location_shares: [
        { id: liveId, company_id: COMPANY, user_id: DRV, mode: 'until_off', started_at: iso(NOW - 40 * 24 * 3600e3), expires_at: null, stopped_at: null },
        { id: deadId, company_id: COMPANY, user_id: DRV2, mode: 'timed', duration_hours: 8, started_at: iso(NOW - 20 * 24 * 3600e3), expires_at: iso(NOW - 10 * 24 * 3600e3), stopped_at: iso(NOW - 8 * 24 * 3600e3) },
      ],
      location_pings: [
        { id: 1, share_id: liveId, company_id: COMPANY, lat: 1, lng: 1, recorded_at: iso(NOW - 31 * 24 * 3600e3) },
        { id: 2, share_id: liveId, company_id: COMPANY, lat: 1, lng: 1, recorded_at: iso(NOW - 2 * 24 * 3600e3) },
        { id: 3, share_id: deadId, company_id: COMPANY, lat: 1, lng: 1, recorded_at: iso(NOW - 9 * 24 * 3600e3) },
      ],
      location_share_latest: [
        { share_id: liveId, company_id: COMPANY, user_id: DRV, lat: 1, lng: 1, recorded_at: iso(NOW - 2 * 24 * 3600e3) },
        { share_id: deadId, company_id: COMPANY, user_id: DRV2, lat: 1, lng: 1, recorded_at: iso(NOW - 9 * 24 * 3600e3) },
      ],
    },
  });
  const r = await purgeOldPings(db, NOW);
  assert.ok(r.n >= 2);
  assert.deepEqual(db.db.location_pings.map((p) => p.id), [2]);
  assert.deepEqual(db.db.location_share_latest.map((p) => p.share_id), [liveId]);
});

// ---- cron secret ----
test('cron: no CRON_SECRET → 503 and no work; wrong secret → 401; good secret expires and purges', async () => {
  const sid = '00000000-0000-4000-8000-0000000000a1';
  const db = world({
    tables: {
      location_shares: [{ id: sid, company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 1, started_at: iso(NOW - 2 * 3600e3), expires_at: iso(NOW - 1000), stopped_at: null }],
    },
  });
  const req = (h) => new Request('http://x/api/cron/location-shares', { headers: h ? { authorization: h } : {} });
  const no = await cronLocationShares(req(), { env: {}, sb: db, now: () => NOW });
  assert.equal(no.status, 503);
  assert.match((await no.json()).error, /CRON_SECRET is not set/);
  assert.equal(db.db.location_shares[0].stopped_at, null);
  const bad = await cronLocationShares(req('Bearer nope'), { env: { CRON_SECRET: 's3cret' }, sb: db, now: () => NOW });
  assert.equal(bad.status, 401);
  const ok = await cronLocationShares(req('Bearer s3cret'), { env: { CRON_SECRET: 's3cret' }, sb: db, now: () => NOW });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.expired, 1);
  assert.equal(body.retention.maxAgeDays, 30);
  assert.equal(db.db.location_shares[0].stopped_reason, 'expired');
  assert.equal(cronAuthorized('', {}).status, 503);
  assert.equal(cronAuthorized('Bearer s3cret', { CRON_SECRET: 's3cret' }).ok, true);
});

test('runLocationShareCron returns both expired and purged counts', async () => {
  const db = world();
  const r = await runLocationShareCron(db, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.expired, 0);
  assert.equal(r.purged, 0);
});

test('untilLabel and consent text say updates pause when the app is closed or the phone is locked', () => {
  const share = { mode: 'timed', expires_at: iso(NOW + 2 * 3600e3) };
  assert.match(untilLabel(share, NOW, { locale: 'en-US', timeZone: 'UTC' }), /until/);
  assert.equal(untilLabel({ mode: 'until_off', expires_at: null }, NOW), 'until you turn it off');
  assert.match(CONSENT_FOREGROUND, /switch apps or lock the phone/);
  assert.match(read('app/components/LocationShareBar.js'), /Updates pause if you close the app or lock the phone/);
});

test('migration is Phase 1 only, additive, and keeps retention parameterized', () => {
  const sql = read('supabase/migrations/20261117000100_location_shares.sql');
  assert.match(sql, /NOT APPLIED/);
  assert.match(sql, /ADDITIVE ONLY/);
  assert.equal(/location_share_links/.test(sql), false, 'no Phase 2 link table');
  assert.match(sql, /stopped_by/);
  assert.match(sql, /create table if not exists public\.location_shares/);
  assert.match(sql, /create table if not exists public\.location_pings/);
  assert.match(sql, /create table if not exists public\.location_share_latest/);
  assert.match(sql, /p_max_age interval default interval '30 days'/);
  assert.match(sql, /p_after_end interval default interval '7 days'/);
  assert.match(sql, /location_pings_fill_from_share/);
  assert.match(sql, /s\.company_id = location_pings\.company_id/);
  assert.equal(/s\.company_id = company_id/.test(sql), false, 'unqualified company_id in pings policy');
  assert.match(sql, /location_shares_force_insert_nulls/);
  assert.match(sql, /location_shares_guard_update/);
  assert.match(sql, /location_is_service_role/);
  assert.equal(/alter table public\.(loads|stops|company_profiles|company_members)\b/i.test(sql), false);
  assert.match(read('app/api/cron/location-shares/route.js'), /CRON_SECRET/);
  assert.match(read('vercel.json'), /\/api\/cron\/location-shares/);
  assert.match(read('app/lib/companyExport.js'), /location_shares/);
  assert.match(read('app/api/loads/[id]/stops/[stopId]/route.js'), /stopSharesForDeliveredLoad/);
  assert.match(read('app/components/AppNav.js'), /LocationShareBar/);
  // Existing "Use my location" copy is unchanged.
  assert.match(read('app/account/settings/page.js'), /Your position is used only while that screen is open and is never saved/);
  assert.equal(/location_share_links/.test(read('app/lib/companyExport.js')), false);
});


test('insert trigger: stopped_at, last_reminded_at, stopped_by, stopped_reason are forced null', () => {
  const row = normalizeShareInsert({
    company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 8,
    started_at: iso(NOW), expires_at: iso(NOW + 8 * 3600e3),
    stopped_at: iso(NOW), last_reminded_at: iso(NOW), stopped_by: DISP, stopped_reason: 'office',
  });
  assert.equal(row.stopped_at, null);
  assert.equal(row.last_reminded_at, null);
  assert.equal(row.stopped_by, null);
  assert.equal(row.stopped_reason, null);
  assert.equal(row.user_id, DRV);
});

test('update guard: office cannot un-stop or extend a share; driver cannot change company_id', () => {
  const live = {
    id: '00000000-0000-4000-8000-0000000000a1', company_id: COMPANY, user_id: DRV,
    started_at: iso(NOW - 1000), mode: 'timed', duration_hours: 8, expires_at: iso(NOW + 8 * 3600e3),
    created_at: iso(NOW - 1000), stopped_at: null, stopped_reason: null, stopped_by: null, last_reminded_at: null,
  };
  const office = { actorId: DISP, isOffice: true, isServiceRole: false, now: NOW };
  const extend = guardShareUpdate(live, { ...live, expires_at: iso(NOW + 24 * 3600e3) }, office);
  assert.equal(extend.ok, false);
  assert.equal(extend.error, 'location_share_locked');
  assert.equal(extend.column, 'expires_at');
  const stopped = { ...live, stopped_at: iso(NOW), stopped_reason: 'office', stopped_by: DISP };
  const okStop = guardShareUpdate(live, stopped, office);
  assert.equal(okStop.ok, true);
  const unstop = guardShareUpdate(stopped, { ...stopped, stopped_at: null, stopped_reason: null, stopped_by: null }, office);
  assert.equal(unstop.ok, false);
  assert.equal(unstop.error, 'location_share_already_stopped');
  const changeStop = guardShareUpdate(stopped, { ...stopped, stopped_at: iso(NOW + 1000) }, office);
  assert.equal(changeStop.ok, false);

  const driver = { actorId: DRV, isOffice: false, isServiceRole: false, now: NOW };
  const moveCo = guardShareUpdate(live, { ...live, company_id: '00000000-0000-4000-8000-0000000000c2' }, driver);
  assert.equal(moveCo.ok, false);
  assert.equal(moveCo.error, 'location_share_locked');
  assert.equal(moveCo.column, 'company_id');
  assert.ok(SHARE_LOCK_COLS.includes('company_id'));
  const selfStop = guardShareUpdate(live, { ...live, stopped_at: iso(NOW), stopped_reason: 'user', stopped_by: DRV }, driver);
  assert.equal(selfStop.ok, true);
  const remind = guardShareUpdate(live, { ...live, last_reminded_at: iso(NOW) }, driver);
  assert.equal(remind.ok, true);
  const officeRemind = guardShareUpdate(live, { ...live, last_reminded_at: iso(NOW) }, office);
  assert.equal(officeRemind.ok, false);
  // service role (cron / delivered auto-stop) is exempt
  const svc = guardShareUpdate(live, { ...live, stopped_at: iso(NOW), stopped_reason: 'delivered', stopped_by: null }, { isServiceRole: true, now: NOW });
  assert.equal(svc.ok, true);
});

test('startShare: an expired-but-unstopped share is stamped expired, then a new share can start', async () => {
  const oldId = '00000000-0000-4000-8000-0000000000a1';
  const db = world({
    tables: {
      location_shares: [{
        id: oldId, company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 1,
        started_at: iso(NOW - 2 * 3600e3), expires_at: iso(NOW - 60e3), stopped_at: null,
      }],
    },
  });
  // Unique index would block a second row with stopped_at null; restart must stamp the old one first.
  const r = await startShare(db, ctx(DRV, 'driver'), { duration_hours: 8 }, NOW);
  assert.equal(r.share.live, true);
  assert.equal(r.share.duration_hours, 8);
  assert.notEqual(r.share.id, oldId);
  const old = db.db.location_shares.find((x) => x.id === oldId);
  assert.equal(old.stopped_reason, 'expired');
  assert.ok(old.stopped_at);
  assert.equal(db.db.location_shares.filter((x) => !x.stopped_at).length, 1);
});

test('fillPingFromShare overwrites a spoofed company_id from the share', () => {
  const share = { id: 's', company_id: COMPANY, user_id: DRV };
  const ping = fillPingFromShare({ share_id: 's', company_id: '00000000-0000-4000-8000-0000000000c9', lat: 1, lng: 2 }, share);
  assert.equal(ping.company_id, COMPANY);
});
