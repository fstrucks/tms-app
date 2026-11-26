// Location sharing Phase 1. Fake data only (Test Trucking Co). Never calls a real database or routing service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  DURATION_HOURS, DEFAULT_DURATION_HOURS, PING_MIN_GAP_MS, PING_MAX_AGE_DAYS, PING_AFTER_END_DAYS,
  validateStart, isShareLive, expiryPatch, viewShare, canStartShare, canStopShare, canReadShare,
  canStartForOthers, defaultAutoStopOnDelivered, shouldRemind, pingAllowed, shouldPurgePing,
  shouldPurgeLatest, untilLabel, cronAuthorized, intervalSql, REMIND_AFTER_MS, CONSENT_FOREGROUND, CONSENT_WHO, CONSENT_LINE,
  normalizeShareInsert, guardShareUpdate, fillPingFromShare, SHARE_LOCK_COLS,
  STALE_MS, HEARTBEAT_MS, isStale, shouldShowStopNotice, readStopSeen, markStopSeen, clockOffset, officeRowView, STOP_SEEN_KEY, lastSeenAt, pickOfficeStopNotice, officeStopText, alreadySharingText,
} from '../../app/lib/locationShare.js';
import {
  startShare, stopShare, recordPing, officeShares, stopSharesForDeliveredLoad,
  expireDueShares, purgeOldPings, runLocationShareCron, markReminded, cronLocationShares, myShareState,
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
  // Settings copy: approved wording (Nov 19), says sharing is separate.
  assert.match(read('app/account/settings/page.js'), /Your position is used only while that screen is open and isn’t saved\. This setting is for this device only\. Sharing your location with your company is separate/);
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

// ---- Taylor QA (#179): owner as office, notices, stale, heartbeat ----
const SID = '00000000-0000-4000-8000-0000000000a7';
const liveRow = (over = {}) => ({ id: SID, company_id: COMPANY, user_id: DRV, mode: 'timed', duration_hours: 8, started_at: iso(NOW - 3600e3), expires_at: iso(NOW + 3600e3), stopped_at: null, ...over });

test('owner counts as office: sees the live shares list and can remotely stop (reason office, stopped_by owner)', async () => {
  const db = world({ tables: { location_shares: [liveRow()], location_share_latest: [{ share_id: SID, company_id: COMPANY, user_id: DRV, lat: 41.8, lng: -87.6, recorded_at: iso(NOW - 30e3), updated_at: iso(NOW - 30e3) }] } });
  const list = await officeShares(db, ctx(OWNER, 'owner'), NOW);
  assert.equal(list.shares.length, 1);
  const r = await stopShare(db, ctx(OWNER, 'owner'), { shareId: SID, reason: 'office' }, NOW);
  assert.equal(r.share.stopped_reason, 'office');
  assert.equal(r.share.stopped_by, OWNER);
  assert.equal(db.db.location_shares[0].stopped_at != null, true);
  assert.equal((await officeShares(db, ctx(OWNER, 'owner'), NOW)).shares.length, 0);
});

test('owner panel wiring: /dispatch renders the shares panel for the owner above the owner copy; Loads page shows it only when someone shares', () => {
  const d = read('app/dispatch/page.js');
  assert.match(d, /state\.owner && <OfficeLocationPanel \/>/);
  assert.match(d, /owner: \(acc\.roles \|\| \[\]\)\.includes\('owner'\)/);
  assert.match(d, /copy: notMemberCopy\(\['owner'\]\), owner: true/);
  assert.match(read('app/loads/page.js'), /<OfficeLocationPanel hideWhenEmpty \/>/);
  assert.match(read('app/components/OfficeLocationPanel.js'), /hideWhenEmpty/);
});

test('stale: no update or heartbeat for more than 5 minutes shows Not updating; a heartbeat keeps a parked truck fresh', async () => {
  assert.equal(STALE_MS, 5 * 60_000);
  assert.ok(HEARTBEAT_MS < STALE_MS && HEARTBEAT_MS >= 120_000 && HEARTBEAT_MS <= 180_000);
  assert.equal(isStale(NOW - 4 * 60_000, NOW), false);
  assert.equal(isStale(NOW - 5 * 60_000 - 1, NOW), true);
  const old = { share_id: SID, lat: 1, lng: 1, recorded_at: iso(NOW - 12 * 60_000), updated_at: iso(NOW - 12 * 60_000) };
  assert.equal(isStale(lastSeenAt(liveRow(), old), NOW), true);
  const fresh = { ...old, updated_at: iso(NOW - 60_000) }; // stored point is old (parked) but a heartbeat came in
  assert.equal(isStale(lastSeenAt(liveRow(), fresh), NOW), false);
  const db = world({ tables: { location_shares: [liveRow()], location_share_latest: [{ ...old, company_id: COMPANY, user_id: DRV }] } });
  const a = (await officeShares(db, ctx(DISP, 'dispatcher'), NOW)).shares[0];
  assert.equal(a.stale, true);
  assert.equal(a.stale_text, 'Not updating, app may be closed');
  db.db.location_share_latest[0].updated_at = iso(NOW - 60_000);
  assert.equal((await officeShares(db, ctx(DISP, 'dispatcher'), NOW)).shares[0].stale, false);
});

test('heartbeat ping while parked touches only updated_at: no new ping row, and at most once a minute', async () => {
  const db = world({ tables: { location_shares: [liveRow()], location_share_latest: [{ share_id: SID, company_id: COMPANY, user_id: DRV, lat: 41.8, lng: -87.6, recorded_at: iso(NOW - 10 * 60_000), updated_at: iso(NOW - 150_000) }] } });
  const r = await recordPing(db, ctx(DRV, 'driver'), { share_id: SID, lat: 41.8001, lng: -87.6001, heartbeat: true }, NOW);
  assert.equal(r.heartbeat, true);
  assert.equal(db.db.location_pings.length, 0);
  assert.equal(db.db.location_share_latest[0].updated_at, iso(NOW));
  assert.equal(db.db.location_share_latest[0].recorded_at, iso(NOW - 10 * 60_000)); // stored point time unchanged
  const again = await recordPing(db, ctx(DRV, 'driver'), { share_id: SID, lat: 41.8001, lng: -87.6001, heartbeat: true }, NOW + 20_000);
  assert.equal(again.skipped, 'rate');
  // Moved far from the latest point: stored as a normal ping instead.
  const moved = await recordPing(db, ctx(DRV, 'driver'), { share_id: SID, lat: 42.5, lng: -87.6, heartbeat: true }, NOW + 5 * 60_000);
  assert.equal(moved.ok, true);
  assert.equal(db.db.location_pings.length, 1);
  assert.match(read('app/components/LocationShareBar.js'), /HEARTBEAT_MS/);
});

test('office stop notice: shown for a recent office stop, once; not for other reasons, old stops, or while sharing', async () => {
  const stoppedAt = NOW - 20 * 60_000;
  const rows = [
    { id: 'a1', stopped_reason: 'user', stopped_at: iso(NOW - 60_000) },
    { id: 'a2', stopped_reason: 'office', stopped_at: iso(stoppedAt) },
    { id: 'a3', stopped_reason: 'office', stopped_at: iso(NOW - 3 * 86400e3) },
  ];
  assert.deepEqual(pickOfficeStopNotice(rows, { now: NOW }), { id: 'a2', stopped_at: iso(stoppedAt) });
  assert.equal(pickOfficeStopNotice(rows, { now: NOW, seenId: 'a2' }), null); // already shown
  assert.equal(pickOfficeStopNotice([rows[0], rows[2]], { now: NOW }), null);
  const text = officeStopText({ stopped_at: iso(Date.parse('2026-11-17T14:00:00Z') - 20 * 60_000) }, { timeZone: 'America/Chicago', now: NOW });
  assert.equal(text, 'Your dispatcher stopped location sharing at 7:40 AM.');
  const db = world({ tables: { location_shares: [liveRow({ user_id: DRV, stopped_at: iso(stoppedAt), stopped_reason: 'office', stopped_by: DISP })] } });
  const st = await myShareState(db, { userId: DRV, ownerId: OWNER, companyId: COMPANY, role: 'driver' }, NOW);
  assert.equal(st.share, null);
  assert.equal(st.stopped_notice.id, SID);
  const sharing = await startShare(db, ctx(DRV, 'driver'), { duration_hours: 1 }, NOW);
  assert.ok(sharing.share);
  const st2 = await myShareState(db, { userId: DRV, ownerId: OWNER, companyId: COMPANY, role: 'driver' }, NOW);
  assert.equal(st2.stopped_notice, null); // live share: no notice
  assert.match(read('app/location/page.js'), /location-office-stop-notice/);
});

test('already sharing: second start returns 409 already_sharing with a plain message; the page states it with the end time', async () => {
  const db = world({ tables: { location_shares: [liveRow()] } });
  const r = await startShare(db, ctx(DRV, 'driver'), { duration_hours: 4 }, NOW);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'already_sharing');
  assert.match(r.error, /already sharing/i);
  assert.equal(alreadySharingText({ mode: 'until_off' }, NOW), 'You’re already sharing until you turn it off.');
  assert.match(alreadySharingText({ mode: 'timed', expires_at: iso(NOW + 3600e3) }, NOW, { timeZone: 'America/Chicago' }), /^You’re already sharing until 9:00 AM\.$/);
  assert.match(read('app/location/page.js'), /location-already-sharing/);
});

test('office map uses the same tile URL and referrer policy as the route map', () => {
  const m = read('app/components/OfficeLocationMap.js'), r = read('app/components/RouteMap.js');
  assert.match(m, /TILE_URL = 'https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png'/);
  assert.match(m, /referrerPolicy: 'strict-origin-when-cross-origin'/);
  assert.match(r, /referrerPolicy: 'strict-origin-when-cross-origin'/);
});

// ---- Taylor recheck (#179, c2edd18) ----
import * as MINE from '../../app/api/location-share/route.js';
import * as OFFICE from '../../app/api/location-share/office/route.js';
const apiReq = () => new Request('http://x/api/location-share', { headers: { authorization: 'Bearer t' } });
function apiDeps(db, userId, role) {
  const uc = fakeSupabase({
    tables: {
      company_profiles: [{ id: COMPANY, owner_id: OWNER, legal_name: 'Test Trucking Co' }],
      company_members: [{ profile_id: COMPANY, user_id: DISP, role: 'dispatcher', created_at: '2026-11-01T00:00:00Z' }, { profile_id: COMPANY, user_id: DRV, role: 'driver', created_at: '2026-11-01T00:00:00Z' }, { profile_id: COMPANY, user_id: OWNER, role: 'owner', created_at: '2026-11-01T00:00:00Z' }],
    },
    user: { id: userId }, role,
  });
  return { mkUserClient: () => uc, sb: db, now: () => NOW };
}

test('GET /api/location-share returns stopped_notice after an office stop (dispatcher AND owner) and a server_now', async () => {
  for (const [who, role] of [[DISP, 'dispatcher'], [OWNER, 'owner']]) {
    const db = world({ tables: { location_shares: [liveRow()] } });
    const stop = await stopShare(db, ctx(who, role), { shareId: SID, reason: 'office' }, NOW - 20 * 60_000);
    assert.equal(stop.share.stopped_reason, 'office', role);
    const res = await MINE.GET(apiReq(), { deps: apiDeps(db, DRV, 'driver') });
    assert.equal(res.status, 200, role);
    const j = await res.json();
    assert.equal(j.share, null);
    assert.equal(j.stopped_notice?.id, SID, `notice after ${role} stop`);
    assert.equal(j.server_now, iso(NOW));
  }
});

test('office list returns server_now; the panel computes end time, age and stale in the viewer’s zone against the server clock', async () => {
  const db = world({ tables: { location_shares: [liveRow({ expires_at: '2026-11-17T23:34:00Z' })], location_share_latest: [{ share_id: SID, company_id: COMPANY, user_id: DRV, lat: 1, lng: 1, recorded_at: iso(NOW - 12 * 60_000), updated_at: iso(NOW - 2 * 60_000) }] } });
  const j = await (await OFFICE.GET(apiReq(), { deps: apiDeps(db, DISP, 'dispatcher') })).json();
  assert.equal(j.server_now, iso(NOW));
  const row = j.shares[0];
  assert.equal(row.last_seen_at, iso(NOW - 2 * 60_000)); // heartbeat, not the old stored point
  const a = officeRowView(row, { offset: 0, clientNow: NOW });
  assert.equal(a.age, 'Updated 2 min ago');
  assert.equal(a.stale, false);
  const b = officeRowView(row, { offset: 0, clientNow: NOW + 4 * 60_000 }); // later, no new heartbeat
  assert.equal(b.age, 'Updated 6 min ago');
  assert.equal(b.stale, true);
  // A phone clock 10 minutes fast: the offset from server_now cancels it.
  const skew = clockOffset(j.server_now, NOW + 10 * 60_000);
  assert.equal(officeRowView(row, { offset: skew, clientNow: NOW + 10 * 60_000 }).age, 'Updated 2 min ago');
  // End time follows the viewer's zone (process zone here), not a fixed UTC zone.
  assert.equal(a.until, untilLabel(row, NOW));
  assert.doesNotMatch(read('app/lib/locationShareServer.js').replace(/\/\/.*$/gm, ''), /timeZone/);
  assert.match(read('app/components/OfficeLocationPanel.js'), /officeRowView/);
});

test('seen-once: fetching never marks a notice seen; only the render effect on /location does', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
  const st = mem();
  const n = { id: 'n1', stopped_at: iso(NOW) };
  assert.equal(shouldShowStopNotice(n, readStopSeen(st)), true);
  assert.equal(readStopSeen(st), null); // reading/deciding marks nothing
  markStopSeen(st, 'n1');
  assert.equal(st.getItem(STOP_SEEN_KEY), 'n1');
  assert.equal(shouldShowStopNotice(n, readStopSeen(st)), false); // a later visit
  assert.equal(shouldShowStopNotice(n, readStopSeen(st), 'n1'), true); // refetch while it is on screen keeps it
  assert.equal(shouldShowStopNotice(null, null), false);
  // Wiring: the key is written only by markStopSeen, called only from an effect keyed on the rendered notice.
  const page = read('app/location/page.js');
  assert.match(page, /useEffect\(\(\) => \{ if \(noticeId\) markStopSeen\(window\.localStorage, noticeId\); \}, \[noticeId\]\);/);
  assert.equal((page.match(/markStopSeen\(/g) || []).length, 1);
  assert.doesNotMatch(page, /localStorage\.setItem/);
  for (const f of ['app/components/LocationShareBar.js', 'app/components/OfficeLocationPanel.js', 'app/lib/locationShareServer.js', 'app/api/location-share/route.js']) {
    assert.doesNotMatch(read(f), /markStopSeen|ph_loc_stop_seen|STOP_SEEN_KEY/, f);
  }
});

test('delivered auto-stop: the stops response says shareStopped and the stop action pokes the Sharing bar to refetch', async () => {
  const db = world({ tables: { location_shares: [liveRow({ load_id: LOAD, auto_stop_on_delivered: true })] } });
  const r = await stopSharesForDeliveredLoad(db, LOAD, NOW);
  assert.equal(r.n, 1);
  assert.match(read('app/api/loads/[id]/stops/[stopId]/route.js'), /shareStopped/);
  const sa = read('app/components/StopActions.js');
  assert.match(sa, /j\.shareStopped \|\| j\.status === 'delivered'[\s\S]*dispatchEvent\(new Event\('ph-location-share'\)\)/);
  assert.match(read('app/components/LocationShareBar.js'), /addEventListener\('ph-location-share', go\)/);
});

// ---- 3b: every path that can mark a load delivered ends the tied share ----
import * as LD from '../../app/api/location-share/load-delivered/route.js';
import { writeOwnerLoadStatus } from '../../app/lib/autoDispatch.js';
import { markDelivered } from '../../app/lib/homeCurrentLoad.js';
import { saveLoad } from '../../app/lib/dispatch.js';
import { notifyLoadDeliveredClient } from '../../app/lib/locationShareClient.js';
import { sweepDeliveredShares, notifyLoadDelivered } from '../../app/lib/locationShareServer.js';

const tied = () => liveRow({ load_id: LOAD, auto_stop_on_delivered: true });
const setLoad = (db, status) => { db.db.loads[0].status = status; };
const calls = [];
const withFetch = async (fn) => {
  const real = globalThis.fetch; calls.length = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const browserSb = (rowsAfter = { status: 'delivered' }) => ({
  auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  from: () => { const q = { update: () => q, eq: () => q, select: () => q, maybeSingle: async () => ({ data: rowsAfter, error: null }) }; return q; },
  rpc: async () => ({ data: rowsAfter, error: null }),
});

test('read-time sweep (covers every path, incl. direct DB / RPC / bulk): load delivered or invoiced → the driver’s share ends on the next fetch', async () => {
  for (const status of ['delivered', 'invoiced', 'paid']) {
    const db = world({ tables: { location_shares: [tied()] } });
    setLoad(db, status);
    const st = await myShareState(db, { userId: DRV, ownerId: OWNER, companyId: COMPANY, role: 'driver' }, NOW);
    assert.equal(st.share, null, status);
    assert.equal(db.db.location_shares[0].stopped_reason, 'delivered', status);
  }
  const keep = world({ tables: { location_shares: [tied(), liveRow({ id: '00000000-0000-4000-8000-0000000000a8', user_id: DRV2, load_id: LOAD, auto_stop_on_delivered: false })] } });
  setLoad(keep, 'in_transit');
  await sweepDeliveredShares(keep, NOW);
  assert.equal(keep.db.location_shares.every((r) => !r.stopped_at), true); // not delivered: nothing ends
  setLoad(keep, 'delivered');
  const r = await sweepDeliveredShares(keep, NOW);
  assert.equal(r.n, 1); // the one without auto-stop stays
  assert.equal(keep.db.location_shares.find((x) => x.user_id === DRV2).stopped_at, null);
});

test('office list, pings and the cron also sweep; a ping to a delivered load’s share answers ended', async () => {
  const a = world({ tables: { location_shares: [tied()] } }); setLoad(a, 'delivered');
  assert.equal((await officeShares(a, ctx(OWNER, 'owner'), NOW)).shares.length, 0);
  const b = world({ tables: { location_shares: [tied()] } }); setLoad(b, 'delivered');
  const ping = await recordPing(b, ctx(DRV, 'driver'), { share_id: SID, lat: 41.8, lng: -87.6 }, NOW);
  assert.equal(ping.code, 'ended');
  const c = world({ tables: { location_shares: [tied()] } }); setLoad(c, 'delivered');
  const cron = await runLocationShareCron(c, NOW);
  assert.equal(cron.delivered, 1);
});

test('load page status menu (owner direct update) tells the server: writeOwnerLoadStatus → /api/location-share/load-delivered', async () => {
  await withFetch(async () => {
    const r = await writeOwnerLoadStatus(browserSb(), { id: LOAD, status: 'delivered' });
    assert.equal(r.ok, true);
  });
  assert.deepEqual(calls.map((c) => [c.url, c.body.load_id]), [['/api/location-share/load-delivered', LOAD]]);
  await withFetch(async () => { await writeOwnerLoadStatus(browserSb({ status: 'in_transit' }), { id: LOAD, status: 'in_transit' }); });
  assert.equal(calls.length, 0); // other statuses don't call
  assert.match(read('app/loads/[id]/page.js'), /writeOwnerLoadStatus\(supabase, \{ id, status \}\)/);
});

test('Home “Mark as delivered” (markDelivered) and the dispatch editor save (saveLoad status delivered) tell the server too', async () => {
  await withFetch(async () => { assert.equal((await markDelivered(browserSb(), LOAD)).ok, true); });
  assert.equal(calls.length, 1);
  await withFetch(async () => { assert.equal((await saveLoad(browserSb(), LOAD, { status: 'delivered' })).ok, true); });
  assert.equal(calls.length, 1);
  await withFetch(async () => { await saveLoad(browserSb({ status: 'in_transit' }), LOAD, { status: 'in_transit', notes: 'x' }); });
  assert.equal(calls.length, 0);
});

test('client notifier never throws without a session or a fetch', async () => {
  assert.equal(await notifyLoadDeliveredClient({ auth: { getSession: async () => ({ data: {} }) } }, LOAD), false);
  assert.equal(await notifyLoadDeliveredClient(browserSb(), LOAD, { fetchImpl: async () => { throw new Error('offline'); } }), false);
});

test('load-delivered endpoint: only ends shares when the load is really delivered, and only for the load’s company', async () => {
  const mk = () => world({ tables: { location_shares: [tied()] } });
  const post = (db, uid, role, loadId = LOAD) => LD.POST(new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ load_id: loadId }) }), { deps: apiDeps(db, uid, role) });
  const a = mk();
  assert.equal((await (await post(a, OWNER, 'owner')).json()).stopped, 0); // not delivered yet: abused call does nothing
  assert.equal(a.db.location_shares[0].stopped_at, null);
  setLoad(a, 'delivered');
  const ok = await (await post(a, OWNER, 'owner')).json();
  assert.equal(ok.stopped, 1);
  assert.equal(a.db.location_shares[0].stopped_reason, 'delivered');
  const b = mk(); setLoad(b, 'delivered');
  assert.ok([403, 404].includes((await post(b, DRV2, 'driver')).status)); // a driver not on that load / not in the company
  assert.equal(b.db.location_shares[0].stopped_at, null);
  const c = mk(); setLoad(c, 'delivered'); c.db.loads[0].user_id = '00000000-0000-4000-8000-0000000000ee'; // another company's load
  assert.equal((await post(c, OWNER, 'owner')).status, 404);
  const d = mk(); setLoad(d, 'delivered');
  assert.equal((await post(d, DRV, 'driver')).status, 200); // the assigned driver may
  assert.equal((await notifyLoadDelivered(mk(), ctx(OWNER, 'owner'), 'nope', NOW)).status, 422);
});

test('stop check-off route still ends the share (existing path) and the bar refetches on its poll', () => {
  assert.match(read('app/api/loads/[id]/stops/[stopId]/route.js'), /stopSharesForDeliveredLoad/);
  const bar = read('app/components/LocationShareBar.js');
  assert.match(bar, /const pollMs = 30_000;/);
  assert.match(bar, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) go\(\); \}, pollMs\)/);
});

// ---- Load delete must never be blocked by its shares (TEST-QA179J) ----
test('guard: load delete (load_id → NULL, load gone, nothing else changed) is allowed for stopped AND live shares', () => {
  const stopped = liveRow({ load_id: LOAD, stopped_at: iso(NOW - 3600e3), stopped_reason: 'user', stopped_by: DRV });
  const live = liveRow({ load_id: LOAD });
  for (const row of [stopped, live]) {
    for (const who of [{ actorId: OWNER, isOffice: true }, { actorId: DRV }]) {
      assert.equal(guardShareUpdate(row, { ...row, load_id: null }, { ...who, now: NOW, loadExists: false }).ok, true);
    }
  }
  // History intact: any other change alongside load_id is still refused.
  assert.equal(guardShareUpdate(stopped, { ...stopped, load_id: null, stopped_reason: 'office' }, { actorId: OWNER, isOffice: true, now: NOW, loadExists: false }).ok, false);
  assert.equal(guardShareUpdate(live, { ...live, load_id: null, expires_at: iso(NOW + 99e6) }, { actorId: DRV, now: NOW, loadExists: false }).ok, false);
  // The load still exists: a client cannot detach a share from it (still refused, as before).
  assert.equal(guardShareUpdate(stopped, { ...stopped, load_id: null }, { actorId: OWNER, isOffice: true, now: NOW, loadExists: true }).ok, false);
  assert.equal(guardShareUpdate(live, { ...live, load_id: null }, { actorId: DRV, now: NOW, loadExists: true }).ok, false);
});

test('delete-fix migration: new additive file, one function replaced, load-gone + only-load_id condition, copied for review', () => {
  const m = read('supabase/migrations/20261118000200_location_shares_load_delete_fix.sql');
  assert.match(m, /create or replace function public\.location_shares_guard_update\(\)/);
  assert.match(m, /not exists \(select 1 from public\.loads l where l\.id = old\.load_id\)/);
  assert.match(m, /\(to_jsonb\(new\) - 'load_id'\) = \(to_jsonb\(old\) - 'load_id'\)/);
  assert.match(m, /old\.load_id is not null and new\.load_id is null/);
  assert.doesNotMatch(m.replace(/^--.*$/gm, ''), /\b(drop table|alter table|drop policy|create policy|grant |delete from|insert into|update public)/i);
  // The exception sits right after the service-role exit and before every rejecting check.
  assert.ok(m.indexOf('load row no longer exists') < m.indexOf("raise exception 'location_share_locked'"));
  assert.ok(m.indexOf('load row no longer exists') < m.indexOf("raise exception 'location_share_already_stopped'"));
});

test('several stopped shares on one load (the J case): every one is allowed to detach; the guard rule does not depend on how many', () => {
  const rows = [1, 2, 3].map((n) => liveRow({ id: `00000000-0000-4000-8000-00000000f00${n}`, load_id: LOAD, stopped_at: iso(NOW - n * 3600e3), stopped_reason: n === 2 ? 'delivered' : 'user' }));
  for (const r of rows) assert.equal(guardShareUpdate(r, { ...r, load_id: null }, { actorId: OWNER, isOffice: true, now: NOW, loadExists: false }).ok, true);
  assert.match(read('app/lib/loadDelete.js'), /from\('loads'\)\.delete\(\)/); // the delete is a direct owner delete: nothing to detach app-side
});

test('approved wording (Nov 19): consent says history, retention constants stay 30/7, Home map copy says not saved', () => {
  assert.equal(PING_MAX_AGE_DAYS, 30); assert.equal(PING_AFTER_END_DAYS, 7);
  assert.match(CONSENT_WHO, /look back at the points we save while we keep them\. Other drivers cannot\.$/);
  assert.match(CONSENT_LINE, /can look back at the points we save\. PowerHaul sends location only while it is open on your screen\. You can stop any time\.$/);
  // The optional retention sentence is held until the production cron is confirmed (not shipped).
  assert.equal(/CONSENT_RETENTION/.test(read('app/location/page.js')), false);
  const page = read('app/location/page.js');
  assert.ok(page.indexOf('{CONSENT_LINE}') < page.indexOf('data-testid="location-start"'));
  const map = read('app/components/LoadMapPanel.js');
  assert.match(map, /It’s used only while this screen is open and isn’t saved\. \(Sharing your location with your company is separate and only happens if you start it\.\)/);
  assert.match(map, /location used only while this screen is open, not saved</);
  assert.equal(/never saved/.test(map), false);
  // Phone app background sharing (Nov 25): the Nov 19 iOS text promised "sent only while the app is open", which is no
  // longer true in the app. Replaced with a DRAFT pending Marc's approval (powerhaul-docs/2026-11-25_native-app-wording_DRAFT.md).
  assert.match(read('ios/App/App/Info.plist'), /show miles left and ETA on the load map\. If you turn on location sharing, your location is sent to your company's owner, dispatchers and management until you stop sharing, including while the app is in the background\./);
});

test('/location refetches on ph-location-share, visibility, and a poll so Stop clears “already sharing” without a reload', () => {
  const page = read('app/location/page.js');
  const bar = read('app/components/LocationShareBar.js');
  assert.match(page, /addEventListener\('ph-location-share', go\)/);
  assert.match(page, /addEventListener\('visibilitychange', vis\)/);
  assert.match(page, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) go\(\); \}, 30_000\)/);
  assert.match(page, /removeEventListener\('ph-location-share', go\)/);
  // The bar already dispatched this event from its own Stop. It also dispatches when a refresh
  // finds the share has ended (office stop or expiry), after updating shareRef so it cannot loop.
  assert.match(bar, /if \(had\) window\.dispatchEvent\(new Event\('ph-location-share'\)\)/);
  assert.match(bar, /if \(had && !s\) window\.dispatchEvent\(new Event\('ph-location-share'\)\)/);
  assert.match(bar, /shareRef\.current = s;/);
  assert.match(bar, /shareRef\.current = null;/);
});
