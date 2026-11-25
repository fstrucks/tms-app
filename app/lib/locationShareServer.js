// Server side of location sharing Phase 1. No emails, never logs coordinates, keys, or addresses.
// Writes go through the service client after the caller is authorized. RLS still protects direct access.
import { truckCtx, json, isMissing, UUID } from './truckServer.js';
import { serviceClient } from './packetServer.js';
import { loadMyCompanies, resolveActive, readActiveCookie } from './activeCompany.js';
import {
  validateStart, canStartShare, canStopShare, canReadShare, isShareLive, expiryPatch, viewShare,
  shouldRemind, pingAllowed, defaultAutoStopOnDelivered, isOfficeRole, publicShareView,
  PING_MAX_AGE_DAYS, PING_AFTER_END_DAYS, SETUP_MSG, intervalSql, cronAuthorized,
  normalizeShareInsert, guardShareUpdate, fillPingFromShare, isMoving, pickOfficeStopNotice, loadIsDone, LOAD_DONE_STATUSES,
} from './locationShare.js';
import {
  newDeviceKey, hashDeviceKey, deviceKeyExpiry, checkDeviceKeyRow, requestTooSoon, parseDeviceBody, thinPoints,
  DEVICE_KEY_MAX_AGE_MS,
} from './locationShareDevice.js';

const HEARTBEAT_MIN_GAP_MS = 60_000; // a heartbeat touches one timestamp at most once a minute

export { json };
export const SETUP = { error: SETUP_MSG, setupNeeded: true };

const missing = (e) => isMissing(e);

export async function locationShareCtx(req, deps = {}) {
  const c = await truckCtx(req, deps);
  if (c.res) return c;
  const db = deps.sb || (deps.mkService ? deps.mkService() : serviceClient()) || c.db;
  if (!db) return { res: json({ error: 'Location sharing isn’t set up on this server yet.' }, 503) };
  const companiesRes = await loadMyCompanies(c.uc || db, c.user.id);
  if (companiesRes.error) {
    if (missing(companiesRes.error)) return { res: json(SETUP, 409) };
    return { res: json({ error: 'Couldn’t load your company.' }, 500) };
  }
  const active = resolveActive(companiesRes.companies, c.user.id, readActiveCookie(req, c.user.id));
  if (!active) return { res: json({ error: 'Not allowed.' }, 403) };
  return {
    user: c.user,
    role: active.role,
    companyId: active.profile_id,
    ownerId: active.owner_id,
    db,
    now: () => (deps.now ? deps.now() : Date.now()),
  };
}

async function loadShare(db, id) {
  const { data, error } = await db.from('location_shares').select('*').eq('id', id).maybeSingle();
  if (error) return { error };
  return { share: data || null };
}

async function stampExpired(db, share, now) {
  const patch = expiryPatch(share, now);
  if (!patch) return share;
  const { data, error } = await db.from('location_shares').update(patch).eq('id', share.id).is('stopped_at', null).select('*');
  if (error) return { ...share, ...patch };
  return (data && data[0]) || { ...share, ...patch };
}

export async function expireDueShares(db, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const { data, error } = await db.from('location_shares').update({
    stopped_at: iso, stopped_reason: 'expired', stopped_by: null,
  }).is('stopped_at', null).lte('expires_at', iso).not('expires_at', 'is', null).select('id');
  if (error) return { error, n: 0 };
  return { n: (data || []).length };
}

export async function purgeOldPings(db, now = Date.now(), { maxAgeDays = PING_MAX_AGE_DAYS, afterEndDays = PING_AFTER_END_DAYS } = {}) {
  const maxIso = new Date(now - maxAgeDays * 24 * 3600 * 1000).toISOString();
  const endIso = new Date(now - afterEndDays * 24 * 3600 * 1000).toISOString();
  let n = 0;
  const a = await db.from('location_pings').delete().lt('recorded_at', maxIso).select('id');
  if (a.error) return { error: a.error, n: 0 };
  n += (a.data || []).length;
  const ended = await db.from('location_shares').select('id, stopped_at').not('stopped_at', 'is', null).lt('stopped_at', endIso);
  if (ended.error) return { error: ended.error, n };
  const ids = (ended.data || []).map((r) => r.id);
  if (ids.length) {
    const b = await db.from('location_pings').delete().in('share_id', ids).select('id');
    if (b.error) return { error: b.error, n };
    n += (b.data || []).length;
    const c = await db.from('location_share_latest').delete().in('share_id', ids).select('share_id');
    if (c.error) return { error: c.error, n };
    n += (c.data || []).length;
  }
  return { n, maxAgeDays, afterEndDays, interval: { max: intervalSql(maxAgeDays), after: intervalSql(afterEndDays) } };
}

// Catch-all for "stop when this load is marked delivered": ends live shares whose tied load is already delivered, whichever
// screen, RPC or bulk action moved it (the load page, Home, the dispatch editor, the stop check-off, invoicing). Runs on read
// (the driver's bar, the office list, every ping) and in the cron, so it never depends on one code path calling us.
// Service client only; reason 'delivered'. Filters narrow it to one user / company / load.
export async function sweepDeliveredShares(db, now = Date.now(), { userId = null, companyId = null, loadId = null } = {}) {
  let q = db.from('location_shares').select('*').is('stopped_at', null).eq('auto_stop_on_delivered', true).not('load_id', 'is', null);
  if (userId) q = q.eq('user_id', userId);
  if (companyId) q = q.eq('company_id', companyId);
  if (loadId) q = q.eq('load_id', loadId);
  const { data, error } = await q;
  if (error) return { n: 0, error: missing(error) ? null : error };
  const live = (data || []).filter((s) => isShareLive(s, now));
  if (!live.length) return { n: 0 };
  const ids = [...new Set(live.map((s) => s.load_id))];
  const ld = await db.from('loads').select('id, status').in('id', ids);
  if (ld.error) return { n: 0, error: ld.error };
  const done = new Set((ld.data || []).filter((l) => loadIsDone(l.status)).map((l) => l.id));
  let n = 0;
  const iso = new Date(now).toISOString();
  for (const s of live) {
    if (!done.has(s.load_id)) continue;
    const upd = await db.from('location_shares').update({ stopped_at: iso, stopped_reason: 'delivered', stopped_by: null }).eq('id', s.id).is('stopped_at', null).select('id');
    if (!upd.error && upd.data?.length) n += 1;
  }
  return { n };
}

// POST /api/location-share/load-delivered { load_id }: called right after any browser-side write that moves a load to
// delivered. The caller must belong to the load's company (office, or the load's assigned driver), and the load must really
// be delivered in the database, so this can only end a share that should end.
export async function notifyLoadDelivered(db, ctx, loadId, now = Date.now()) {
  if (!loadId || !UUID.test(loadId)) return { error: 'Which load?', status: 422 };
  const { data: load, error } = await db.from('loads').select('id, user_id, status, assigned_driver_user_id').eq('id', loadId).maybeSingle();
  if (error) return missing(error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t check that load.', status: 500 };
  const office = isOfficeRole(ctx.role);
  if (!load || load.user_id !== ctx.ownerId || (!office && load.assigned_driver_user_id !== ctx.userId)) return { error: 'Load not found.', status: 404 };
  if (!loadIsDone(load.status)) return { ok: true, stopped: 0 };
  const r = await sweepDeliveredShares(db, now, { loadId: load.id });
  return { ok: true, stopped: r.n };
}

export async function runLocationShareCron(db, now = Date.now(), opts = {}) {
  const exp = await expireDueShares(db, now);
  if (exp.error) return exp;
  const del = await sweepDeliveredShares(db, now);
  const purge = await purgeOldPings(db, now, opts);
  if (purge.error) return purge;
  await purgeDeviceKeys(db, now);
  return { ok: true, expired: exp.n, delivered: del.n || 0, purged: purge.n, retention: { maxAgeDays: opts.maxAgeDays ?? PING_MAX_AGE_DAYS, afterEndDays: opts.afterEndDays ?? PING_AFTER_END_DAYS } };
}

export async function cronLocationShares(req, deps = {}) {
  const env = deps.env || process.env;
  const auth = cronAuthorized(req.headers.get('authorization'), env);
  if (!auth.ok) return json({ error: auth.error, code: auth.code }, auth.status);
  const db = deps.sb || (deps.mkService ? deps.mkService() : serviceClient());
  if (!db) return json({ error: 'Location sharing isn’t set up on this server yet.' }, 503);
  const now = deps.now ? deps.now() : Date.now();
  const ran = await runLocationShareCron(db, now, {
    maxAgeDays: deps.maxAgeDays ?? PING_MAX_AGE_DAYS,
    afterEndDays: deps.afterEndDays ?? PING_AFTER_END_DAYS,
  });
  if (ran.error) {
    if (missing(ran.error)) return json(SETUP, 409);
    console.warn('[location-share] cron failed', ran.error.code || '');
    return json({ error: 'Couldn’t finish location sharing cleanup.' }, 500);
  }
  return json({ ok: true, expired: ran.expired, purged: ran.purged, retention: ran.retention });
}

async function assignedLoads(db, ownerId, userId) {
  let q = db.from('loads').select('id, broker_load_number, broker_name, status, assigned_driver_user_id, user_id')
    .eq('user_id', ownerId).in('status', ['booked', 'dispatched', 'in_transit']).order('created_at', { ascending: false }).limit(50);
  // Owner-operator can pick any of their open loads; a driver / also-drives member only their assigned ones.
  if (userId !== ownerId) q = q.eq('assigned_driver_user_id', userId);
  const { data, error } = await q;
  if (error) return { error, loads: [] };
  return { loads: data || [] };
}

function loadLabel(l) {
  const num = l.broker_load_number ? `#${l.broker_load_number}` : 'Load';
  return l.broker_name ? `${num} · ${l.broker_name}` : num;
}

export async function myShareState(db, { userId, ownerId, companyId, role }, now = Date.now()) {
  await expireDueShares(db, now);
  await sweepDeliveredShares(db, now, { userId }); // tied load already delivered: end it now, whatever moved the load
  const { data, error } = await db.from('location_shares').select('*')
    .eq('user_id', userId).eq('company_id', companyId).is('stopped_at', null).maybeSingle();
  if (error) return { error };
  let share = data || null;
  if (share) share = await stampExpired(db, share, now);
  const live = share && isShareLive(share, now) ? viewShare(share, now) : null;
  const loads = await assignedLoads(db, ownerId, userId);
  if (loads.error && !missing(loads.error)) return { error: loads.error };
  let stopped_notice = null;
  if (!live) {
    const prior = await db.from('location_shares').select('id, stopped_at, stopped_reason').eq('user_id', userId).eq('stopped_reason', 'office')
      .order('stopped_at', { ascending: false }).limit(3);
    if (!prior.error) stopped_notice = pickOfficeStopNotice(prior.data || [], { now });
  }
  return {
    share: live,
    stopped_notice,
    remind: shouldRemind(live, now),
    loads: (loads.loads || []).map((l) => ({ id: l.id, label: loadLabel(l), status: l.status })),
    canStart: true,
    isOffice: isOfficeRole(role),
  };
}

export async function startShare(db, ctx, body, now = Date.now()) {
  await expireDueShares(db, now);
  if (!canStartShare({ actorId: ctx.userId, targetUserId: ctx.userId })) {
    return { error: 'You can only start sharing from your own device.', status: 403 };
  }
  if (body?.user_id && body.user_id !== ctx.userId) {
    return { error: 'You can only start sharing from your own device.', status: 403 };
  }
  const v = validateStart(body, { now });
  if (v.error) return v;
  if (v.load_id) {
    if (!UUID.test(v.load_id)) return { error: 'Pick a load.', status: 422 };
    const { data: load, error } = await db.from('loads').select('id, user_id, assigned_driver_user_id, status').eq('id', v.load_id).maybeSingle();
    if (error) return missing(error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t check that load.', status: 500 };
    if (!load || load.user_id !== ctx.ownerId) return { error: 'Pick a load that’s assigned to you.', status: 422 };
    if (ctx.userId !== ctx.ownerId && load.assigned_driver_user_id !== ctx.userId) {
      return { error: 'Pick a load that’s assigned to you.', status: 422 };
    }
  }
  v.auto_stop_on_delivered = defaultAutoStopOnDelivered(v.load_id) && v.auto_stop_on_delivered !== false && !!v.load_id;

  // The unique index is "one row per user where stopped_at is null". Stamp any expired-but-unstopped
  // share for this user (stopped_reason 'expired') before insert, so a late cron cannot block a restart.
  const open = await db.from('location_shares').select('*').eq('user_id', ctx.userId).is('stopped_at', null);
  if (open.error) return missing(open.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t start sharing.', status: 500 };
  for (const row of open.data || []) {
    if (isShareLive(row, now)) {
      return { error: 'You’re already sharing. Stop it first, or wait until it ends.', status: 409, code: 'already_sharing' };
    }
    await stampExpired(db, row, now);
  }

  const row = normalizeShareInsert({
    company_id: ctx.companyId,
    user_id: ctx.userId,
    truck_id: v.truck_id && UUID.test(v.truck_id) ? v.truck_id : null,
    load_id: v.load_id,
    started_at: v.started_at,
    expires_at: v.expires_at,
    mode: v.mode,
    duration_hours: v.duration_hours,
    auto_stop_on_delivered: !!v.auto_stop_on_delivered,
    // stopped_at / last_reminded_at / stopped_by / stopped_reason forced null (matches the insert trigger)
  });
  const ins = await db.from('location_shares').insert(row).select('*').maybeSingle();
  if (ins.error) return missing(ins.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t start sharing.', status: 500 };
  return { share: viewShare(ins.data, now) };
}

export async function stopShare(db, ctx, { shareId, reason } = {}, now = Date.now()) {
  if (!shareId || !UUID.test(shareId)) return { error: 'Which share?', status: 422 };
  const got = await loadShare(db, shareId);
  if (got.error) return missing(got.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t stop sharing.', status: 500 };
  if (!got.share) return { error: 'That share isn’t active.', status: 404 };
  if (!canStopShare({ actorId: ctx.userId, actorRole: ctx.role, actorCompanyId: ctx.companyId, share: got.share })) {
    return { error: 'Not allowed.', status: 403 };
  }
  if (!isShareLive(got.share, now)) {
    await stampExpired(db, got.share, now);
    return { share: viewShare({ ...got.share, stopped_at: got.share.stopped_at || new Date(now).toISOString() }, now), already: true };
  }
  const self = got.share.user_id === ctx.userId;
  const stopped_reason = self ? 'user' : (reason === 'delivered' ? 'delivered' : 'office');
  const patch = { stopped_at: new Date(now).toISOString(), stopped_reason, stopped_by: ctx.userId };
  const guard = guardShareUpdate(got.share, { ...got.share, ...patch }, {
    actorId: ctx.userId, isOffice: isOfficeRole(ctx.role), isServiceRole: !!ctx.asService, now,
  });
  if (!guard.ok) return { error: 'Not allowed.', status: guard.status || 403, code: guard.error };
  const { data, error } = await db.from('location_shares').update(patch).eq('id', shareId).is('stopped_at', null).select('*');
  if (error) return { error: 'Couldn’t stop sharing.', status: 500 };
  const row = (data && data[0]) || { ...got.share, ...patch };
  await revokeDeviceKeys(db, shareId, now);
  return { share: viewShare(row, now) };
}

export async function recordPing(db, ctx, body, now = Date.now()) {
  const shareId = body?.share_id;
  if (!shareId || !UUID.test(shareId)) return { error: 'Which share?', status: 422 };
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { error: 'Couldn’t read that location.', status: 422 };
  }
  const got = await loadShare(db, shareId);
  if (got.error) return missing(got.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t save the location.', status: 500 };
  if (!got.share || got.share.user_id !== ctx.userId) return { error: 'Not allowed.', status: 403 };
  let share = await stampExpired(db, got.share, now);
  if (isShareLive(share, now) && share.auto_stop_on_delivered && share.load_id) {
    await sweepDeliveredShares(db, now, { loadId: share.load_id, userId: ctx.userId });
    share = (await loadShare(db, shareId)).share || share;
  }
  if (!isShareLive(share, now)) return { error: 'Sharing has ended.', status: 409, code: 'ended' };

  // Heartbeat ('still open'): a parked device re-sends its position every ~2.5 min. When it hasn't moved from the latest
  // point, only location_share_latest.updated_at is touched (no new ping row), so the office can tell a parked truck from
  // a closed app without growing the table. Moved, or no latest point yet: stored as a normal ping below.
  if (body?.heartbeat === true) {
    const cur = await db.from('location_share_latest').select('lat, lng, updated_at').eq('share_id', shareId).maybeSingle();
    if (!cur.error && cur.data && !isMoving({ lat: cur.data.lat, lng: cur.data.lng }, { lat, lng, speed_mps: body.speed_mps == null ? null : Number(body.speed_mps) })) {
      if (!pingAllowed(cur.data.updated_at, now, HEARTBEAT_MIN_GAP_MS)) return { ok: true, skipped: 'rate' };
      const up = await db.from('location_share_latest').update({ updated_at: new Date(now).toISOString() }).eq('share_id', shareId);
      if (up.error) return { error: 'Couldn’t save the location.', status: 500 };
      return { ok: true, heartbeat: true };
    }
  }

  const last = await db.from('location_pings').select('recorded_at, received_at').eq('share_id', shareId).order('recorded_at', { ascending: false }).limit(1);
  if (last.error && !missing(last.error)) return { error: 'Couldn’t save the location.', status: 500 };
  const lastAt = last.data?.[0]?.recorded_at || last.data?.[0]?.received_at;
  if (!pingAllowed(lastAt, now)) return { ok: true, skipped: 'rate' };

  const recorded_at = body.recorded_at && Number.isFinite(Date.parse(body.recorded_at)) ? body.recorded_at : new Date(now).toISOString();
  const ping = fillPingFromShare({
    share_id: shareId,
    company_id: null, // trigger/helper overwrites this from the share (callers cannot spoof company_id)
    lat, lng,
    accuracy_m: body.accuracy_m == null ? null : Number(body.accuracy_m),
    speed_mps: body.speed_mps == null ? null : Number(body.speed_mps),
    heading: body.heading == null ? null : Number(body.heading),
    recorded_at,
  }, share);
  if (ping.accuracy_m != null && !(ping.accuracy_m >= 0)) ping.accuracy_m = null;
  if (ping.speed_mps != null && !(ping.speed_mps >= 0)) ping.speed_mps = null;
  if (ping.heading != null && !(ping.heading >= 0 && ping.heading < 360)) ping.heading = null;

  const ins = await db.from('location_pings').insert(ping).select('id, recorded_at').maybeSingle();
  if (ins.error) return missing(ins.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t save the location.', status: 500 };

  const latest = {
    share_id: shareId,
    company_id: share.company_id,
    user_id: share.user_id,
    lat, lng,
    accuracy_m: ping.accuracy_m,
    speed_mps: ping.speed_mps,
    heading: ping.heading,
    recorded_at,
    updated_at: new Date(now).toISOString(),
  };
  // Best effort: the trigger also writes this on a real database.
  await db.from('location_share_latest').upsert(latest, { onConflict: 'share_id' });
  return { ok: true, recorded_at };
}

export async function markReminded(db, ctx, shareId, now = Date.now()) {
  if (!shareId || !UUID.test(shareId)) return { error: 'Which share?', status: 422 };
  const got = await loadShare(db, shareId);
  if (got.error) return missing(got.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t update the reminder.', status: 500 };
  if (!got.share || got.share.user_id !== ctx.userId) return { error: 'Not allowed.', status: 403 };
  if (!isShareLive(got.share, now)) return { ok: true, share: viewShare(got.share, now) };
  const patch = { last_reminded_at: new Date(now).toISOString() };
  const guard = guardShareUpdate(got.share, { ...got.share, ...patch }, {
    actorId: ctx.userId, isOffice: isOfficeRole(ctx.role), isServiceRole: !!ctx.asService, now,
  });
  if (!guard.ok) return { error: 'Not allowed.', status: guard.status || 403, code: guard.error };
  const { data, error } = await db.from('location_shares').update(patch).eq('id', shareId).select('*');
  if (error) return { error: 'Couldn’t update the reminder.', status: 500 };
  return { ok: true, share: viewShare((data && data[0]) || got.share, now), remind: false };
}

export async function officeShares(db, ctx, now = Date.now()) {
  if (!isOfficeRole(ctx.role)) return { error: 'Not allowed.', status: 403 };
  await expireDueShares(db, now);
  await sweepDeliveredShares(db, now, { companyId: ctx.companyId });
  const { data, error } = await db.from('location_shares').select('*').eq('company_id', ctx.companyId).is('stopped_at', null);
  if (error) return missing(error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t load shared locations.', status: 500 };
  const rows = [];
  for (const raw of data || []) {
    const share = await stampExpired(db, raw, now);
    if (!isShareLive(share, now)) continue;
    if (!canReadShare({ actorId: ctx.userId, actorRole: ctx.role, actorCompanyId: ctx.companyId, share })) continue;
    rows.push(share);
  }
  const ids = rows.map((s) => s.id);
  let latest = [];
  if (ids.length) {
    const r = await db.from('location_share_latest').select('*').in('share_id', ids);
    if (!r.error) latest = r.data || [];
  }
  const latestBy = Object.fromEntries(latest.map((p) => [p.share_id, p]));
  const loadIds = [...new Set(rows.map((s) => s.load_id).filter(Boolean))];
  let loads = [];
  if (loadIds.length) {
    const r = await db.from('loads').select('id, broker_load_number, broker_name, assigned_driver_user_id').in('id', loadIds);
    if (!r.error) loads = r.data || [];
  }
  const loadBy = Object.fromEntries(loads.map((l) => [l.id, l]));
  const userIds = [...new Set(rows.map((s) => s.user_id))];
  let drivers = [];
  if (userIds.length) {
    const d = await db.from('drivers').select('auth_user_id, name').eq('user_id', ctx.ownerId).in('auth_user_id', userIds);
    if (!d.error) drivers = d.data || [];
  }
  const nameOf = (uid) => {
    const r = drivers.find((x) => x.auth_user_id === uid);
    if (!r) return 'Driver';
    const n = String(r.name || '').trim();
    return n || 'Driver';
  };
  const shares = rows.map((s) => {
    const v = publicShareView(s, latestBy[s.id], now, { label: nameOf(s.user_id) });
    if (!v) return null;
    const l = s.load_id ? loadBy[s.load_id] : null;
    if (l) v.load_ref = loadLabel(l);
    return v;
  }).filter(Boolean);
  return { shares };
}

// Hooked from the stop-completion route after a load's status becomes delivered. Best effort: missing tables are ignored.
// Runs with the service-role client on that route, which the SQL update guard exempts. An office user may also
// set stopped_reason = 'delivered' on a share that has auto_stop_on_delivered and a tied load_id.
export async function stopSharesForDeliveredLoad(db, loadId, now = Date.now()) {
  if (!db || !loadId) return { n: 0 };
  const { data, error } = await db.from('location_shares').select('*')
    .eq('load_id', loadId).is('stopped_at', null).eq('auto_stop_on_delivered', true);
  if (error) return missing(error) ? { n: 0, setupNeeded: true } : { n: 0, error };
  let n = 0;
  const iso = new Date(now).toISOString();
  for (const s of data || []) {
    if (!isShareLive(s, now)) continue;
    const upd = await db.from('location_shares').update({
      stopped_at: iso, stopped_reason: 'delivered', stopped_by: null,
    }).eq('id', s.id).is('stopped_at', null).select('id');
    if (!upd.error && upd.data?.length) n += 1;
  }
  return { n };
}

// ---- Phone app: share-only sending key (background location) ----
// Keys live in location_share_device_keys (service role only; RLS on with no policies). Only the SHA-256 hash is stored.
// Missing table (migration not applied yet) → SETUP for issue/ping, ignored for revoke/purge so nothing else breaks.

export async function revokeDeviceKeys(db, shareId, now = Date.now()) {
  if (!db || !shareId) return { n: 0 };
  const { data, error } = await db.from('location_share_device_keys').update({ revoked_at: new Date(now).toISOString() })
    .eq('share_id', shareId).is('revoked_at', null).select('id');
  if (error) return { n: 0 };
  return { n: (data || []).length };
}

// Daily cron: drop keys that were revoked or ran out more than 7 days ago.
export async function purgeDeviceKeys(db, now = Date.now()) {
  const cut = new Date(now - DEVICE_KEY_MAX_AGE_MS).toISOString();
  const a = await db.from('location_share_device_keys').delete().not('revoked_at', 'is', null).lt('revoked_at', cut).select('id');
  if (a.error) return { n: 0 };
  const b = await db.from('location_share_device_keys').delete().lt('expires_at', cut).select('id');
  return { n: (a.data || []).length + (b.error ? 0 : (b.data || []).length) };
}

// POST /api/location-share/device-key { share_id }: signed-in sharer only, live share only. Replaces any earlier key.
// The plain key is returned once and never stored or logged.
export async function issueDeviceKey(db, ctx, body, now = Date.now()) {
  const shareId = body?.share_id;
  if (!shareId || !UUID.test(shareId)) return { error: 'Which share?', status: 422 };
  const got = await loadShare(db, shareId);
  if (got.error) return missing(got.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t set up sharing on this phone.', status: 500 };
  if (!got.share || got.share.user_id !== ctx.userId || got.share.company_id !== ctx.companyId) return { error: 'Not allowed.', status: 403 };
  const share = await stampExpired(db, got.share, now);
  if (!isShareLive(share, now)) return { error: 'Sharing has ended.', status: 409, code: 'ended' };
  const old = await db.from('location_share_device_keys').update({ revoked_at: new Date(now).toISOString() })
    .eq('share_id', shareId).is('revoked_at', null).select('id');
  if (old.error) return missing(old.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t set up sharing on this phone.', status: 500 };
  const key = newDeviceKey();
  const expires_at = deviceKeyExpiry(share, now);
  const ins = await db.from('location_share_device_keys').insert({
    share_id: share.id, user_id: share.user_id, company_id: share.company_id,
    key_hash: hashDeviceKey(key), created_at: new Date(now).toISOString(), expires_at,
  }).select('id').maybeSingle();
  if (ins.error) return missing(ins.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t set up sharing on this phone.', status: 500 };
  return { key, share_id: share.id, expires_at };
}

const stillInCompany = async (db, userId, companyId) => {
  const r = await loadMyCompanies(db, userId);
  if (r.error) return { error: r.error };
  return { ok: (r.companies || []).some((c) => c.profile_id === companyId) };
};

// POST /api/location-share/device-ping (X-Share-Key header). Body: { points: [{ lat, lng, accuracy_m?, speed_mps?, heading?,
// recorded_at? }] } or one point at the top level, optional heartbeat: true. Writes only to the key's own share, with the
// share's company_id. Same 20 s point floor as the browser, plus one upload per key every 10 s. Never logs coordinates or keys.
export async function recordDevicePings(db, key, body, now = Date.now()) {
  if (!key) return { error: 'Sign in again on this phone.', status: 401, code: 'bad_key' };
  const kr = await db.from('location_share_device_keys').select('*').eq('key_hash', hashDeviceKey(key)).maybeSingle();
  if (kr.error) return missing(kr.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t save the location.', status: 500 };
  const ok = checkDeviceKeyRow(kr.data, now);
  if (!ok.ok) return { error: 'Sign in again on this phone.', status: ok.status, code: ok.code };
  const keyRow = kr.data;
  if (body?.share_id && body.share_id !== keyRow.share_id) return { error: 'Not allowed.', status: 403, code: 'wrong_share' };

  const got = await loadShare(db, keyRow.share_id);
  if (got.error) return { error: 'Couldn’t save the location.', status: 500 };
  if (!got.share) { await revokeDeviceKeys(db, keyRow.share_id, now); return { error: 'Sharing has ended.', status: 409, code: 'ended' }; }
  if (got.share.user_id !== keyRow.user_id || got.share.company_id !== keyRow.company_id) {
    await revokeDeviceKeys(db, keyRow.share_id, now);
    return { error: 'Not allowed.', status: 403 };
  }
  let share = await stampExpired(db, got.share, now);
  if (isShareLive(share, now) && share.auto_stop_on_delivered && share.load_id) {
    await sweepDeliveredShares(db, now, { loadId: share.load_id, userId: share.user_id });
    share = (await loadShare(db, share.id)).share || share;
  }
  if (!isShareLive(share, now)) { await revokeDeviceKeys(db, share.id, now); return { error: 'Sharing has ended.', status: 409, code: 'ended' }; }

  // Removed from the company mid-share: the key stops working and the share is not written to.
  const mem = await stillInCompany(db, share.user_id, share.company_id);
  if (mem.error) return { error: 'Couldn’t save the location.', status: 500 };
  if (!mem.ok) { await revokeDeviceKeys(db, share.id, now); return { error: 'Not allowed.', status: 403, code: 'not_member' }; }

  const wait = requestTooSoon(keyRow.last_used_at, now);
  if (wait) return { error: 'Too many uploads. Try again shortly.', status: 429, code: 'slow_down', retry_after_s: Math.ceil(wait / 1000) };

  const parsed = parseDeviceBody(body, share, now);
  if (parsed.error) return parsed;
  await db.from('location_share_device_keys').update({ last_used_at: new Date(now).toISOString() }).eq('id', keyRow.id);
  if (!parsed.points.length) return { ok: true, saved: 0, skipped: 0, rejected: parsed.rejected };

  // Heartbeat from a parked phone: one point that hasn't moved from the latest → touch updated_at only (as the browser does).
  if (body?.heartbeat === true && parsed.points.length === 1) {
    const p = parsed.points[0];
    const cur = await db.from('location_share_latest').select('lat, lng, updated_at').eq('share_id', share.id).maybeSingle();
    if (!cur.error && cur.data && !isMoving({ lat: cur.data.lat, lng: cur.data.lng }, p)) {
      if (!pingAllowed(cur.data.updated_at, now, HEARTBEAT_MIN_GAP_MS)) return { ok: true, saved: 0, skipped: 1, rejected: parsed.rejected };
      const up = await db.from('location_share_latest').update({ updated_at: new Date(now).toISOString() }).eq('share_id', share.id);
      if (up.error) return { error: 'Couldn’t save the location.', status: 500 };
      return { ok: true, heartbeat: true, saved: 0, skipped: 0, rejected: parsed.rejected };
    }
  }

  const last = await db.from('location_pings').select('recorded_at').eq('share_id', share.id).order('recorded_at', { ascending: false }).limit(1);
  if (last.error && !missing(last.error)) return { error: 'Couldn’t save the location.', status: 500 };
  const { keep, skipped } = thinPoints(parsed.points, last.data?.[0]?.recorded_at);
  if (!keep.length) return { ok: true, saved: 0, skipped, rejected: parsed.rejected };

  const rows = keep.map((p) => fillPingFromShare({
    share_id: share.id, company_id: null, lat: p.lat, lng: p.lng,
    accuracy_m: p.accuracy_m, speed_mps: p.speed_mps, heading: p.heading, recorded_at: new Date(p.t).toISOString(),
  }, share));
  const ins = await db.from('location_pings').insert(rows).select('id');
  if (ins.error) return missing(ins.error) ? { error: SETUP_MSG, status: 409, setupNeeded: true } : { error: 'Couldn’t save the location.', status: 500 };

  const newest = rows[rows.length - 1];
  const cur = await db.from('location_share_latest').select('recorded_at').eq('share_id', share.id).maybeSingle();
  if (!cur.data || !(Date.parse(cur.data.recorded_at) > Date.parse(newest.recorded_at))) {
    await db.from('location_share_latest').upsert({
      share_id: share.id, company_id: share.company_id, user_id: share.user_id,
      lat: newest.lat, lng: newest.lng, accuracy_m: newest.accuracy_m, speed_mps: newest.speed_mps, heading: newest.heading,
      recorded_at: newest.recorded_at, updated_at: new Date(now).toISOString(),
    }, { onConflict: 'share_id' });
  }
  return { ok: true, saved: rows.length, skipped, rejected: parsed.rejected, recorded_at: newest.recorded_at };
}
