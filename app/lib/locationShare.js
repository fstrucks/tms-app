// Location sharing Phase 1 (company only, web foreground). Pure helpers: no React/DOM, no network.
// Unit-tested in tests/js/locationShare.test.mjs.
// Retention defaults (30 days / 7 days after end) are still open with Marc — change the two constants below
// (the cron passes them into purge_location_pings). Do not hard-code the same numbers elsewhere.

export const DURATION_HOURS = [1, 4, 8, 24];
export const DEFAULT_DURATION_HOURS = 8;
export const PING_MIN_GAP_MS = 20_000;             // API floor; faster pings are ignored
export const PING_MOVING_MS = 90_000;              // ~1.5 min while moving
export const PING_STATIONARY_MS = 12 * 60_000;     // 12 min when still
export const MOVE_MI = 100 / 1609.344;             // ~100 m
export const STATIONARY_MPS = 1.34;                // ~3 mph
export const PING_MAX_AGE_DAYS = 30;
export const PING_AFTER_END_DAYS = 7;
export const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
export const OFFICE_ROLES = ['owner', 'management', 'dispatcher'];
export const STOP_REASONS = ['user', 'office', 'expired', 'delivered', 'deleted'];
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DURATION_LABELS = {
  1: '1 hour',
  4: '4 hours',
  8: '8 hours',
  24: '24 hours',
  until_off: 'Until I turn it off',
};

export const CONSENT_WHO = 'The owner, dispatchers, and management at your company can see your position. Other drivers cannot.';
export const CONSENT_FOREGROUND = 'Location is sent while PowerHaul is open on your screen. If you switch apps or lock the phone, sharing pauses until you come back. The share itself stays on until you stop it or it expires, but the map will not move in between.';
export const CONSENT_STOP = 'You can stop at any time with the Stop button, which appears on every screen while you’re sharing. A timed share also ends automatically at the time you chose, even if your phone is off.';
export const REMIND_TEXT = 'You’ve been sharing since yesterday. Stop, or keep sharing.';
export const SETUP_MSG = 'Location sharing needs a database update that hasn’t been applied yet.';

export const isOfficeRole = (role) => OFFICE_ROLES.includes(role);

const ts = (v) => {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return t;
};

export function isShareLive(share, now = Date.now()) {
  if (!share || share.stopped_at) return false;
  const exp = ts(share.expires_at);
  if (Number.isFinite(exp) && exp <= now) return false;
  return true;
}

// If a timed share has passed expires_at but stopped_at was never stamped, treat it as expired on read.
export function expiryPatch(share, now = Date.now()) {
  if (!share || share.stopped_at) return null;
  const exp = ts(share.expires_at);
  if (!Number.isFinite(exp) || exp > now) return null;
  return { stopped_at: new Date(now).toISOString(), stopped_reason: 'expired', stopped_by: null };
}

export function viewShare(share, now = Date.now()) {
  if (!share) return null;
  const patch = expiryPatch(share, now);
  const row = patch ? { ...share, ...patch } : share;
  const live = isShareLive(row, now);
  return { ...row, live, expired: !live && (row.stopped_reason === 'expired' || (!row.stopped_at && !!patch)) };
}

export function canStartShare({ actorId, targetUserId }) {
  return !!actorId && !!targetUserId && actorId === targetUserId;
}

export function canStopShare({ actorId, actorRole, actorCompanyId, share }) {
  if (!share || !actorId) return false;
  if (share.user_id === actorId) return true;
  return isOfficeRole(actorRole) && !!actorCompanyId && share.company_id === actorCompanyId;
}

// Other drivers (same company, not office) cannot read someone else's share.
export function canReadShare({ actorId, actorRole, actorCompanyId, share }) {
  if (!share || !actorId) return false;
  if (share.user_id === actorId) return true;
  return isOfficeRole(actorRole) && !!actorCompanyId && share.company_id === actorCompanyId;
}

export function canStartForOthers() {
  return false;
}

export const defaultAutoStopOnDelivered = (loadId) => !!loadId;

export function validateStart(body = {}, { now = Date.now() } = {}) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // Office cannot start for someone else: ignore any user_id in the body.
  if (raw.user_id != null && raw.target_user_id != null) {
    /* accepted only when it matches the caller, checked by the server with canStartShare */
  }
  let mode = raw.mode;
  let hours = raw.duration_hours == null || raw.duration_hours === '' ? DEFAULT_DURATION_HOURS : Number(raw.duration_hours);
  if (mode == null || mode === '') {
    mode = (raw.until_off === true || hours === 0 || raw.duration === 'until_off') ? 'until_off' : 'timed';
  }
  if (mode !== 'timed' && mode !== 'until_off') return { error: 'Pick how long to share.', status: 422 };
  if (mode === 'until_off') {
    hours = null;
  } else {
    if (!DURATION_HOURS.includes(hours)) return { error: 'Pick 1, 4, 8 or 24 hours, or until you turn it off.', status: 422 };
  }
  const loadId = raw.load_id ? String(raw.load_id) : null;
  const truckId = raw.truck_id ? String(raw.truck_id) : null;
  const auto = loadId ? (raw.auto_stop_on_delivered !== false) : false;
  const startedAt = new Date(now).toISOString();
  const expiresAt = mode === 'until_off' ? null : new Date(now + hours * 3600 * 1000).toISOString();
  return {
    ok: true,
    mode,
    duration_hours: hours,
    started_at: startedAt,
    expires_at: expiresAt,
    load_id: loadId,
    truck_id: truckId,
    auto_stop_on_delivered: auto,
  };
}

export function shouldRemind(share, now = Date.now()) {
  if (!share || share.mode !== 'until_off' || !isShareLive(share, now)) return false;
  const started = ts(share.started_at);
  if (!Number.isFinite(started) || now - started < REMIND_AFTER_MS) return false;
  const last = ts(share.last_reminded_at);
  if (Number.isFinite(last) && now - last < REMIND_AFTER_MS) return false;
  return true;
}

export function pingAllowed(lastAt, now = Date.now(), floorMs = PING_MIN_GAP_MS) {
  if (lastAt == null || lastAt === '') return true;
  const t = ts(lastAt);
  return !Number.isFinite(t) || now - t >= floorMs;
}

export function isMoving(prev, next) {
  if (!next) return false;
  const speed = next.speed_mps;
  if (speed != null && Number(speed) > STATIONARY_MPS) return true;
  if (!prev) return true;
  const dlat = Number(next.lat) - Number(prev.lat);
  const dlng = Number(next.lng) - Number(prev.lng);
  if (![dlat, dlng, next.lat, next.lng, prev.lat, prev.lng].every(Number.isFinite)) return false;
  // Equirectangular approximation is enough for a 100 m filter.
  const mid = ((Number(next.lat) + Number(prev.lat)) / 2) * Math.PI / 180;
  const dy = dlat * 69;
  const dx = dlng * 69 * Math.cos(mid);
  const mi = Math.sqrt(dx * dx + dy * dy);
  return mi >= MOVE_MI;
}

export function nextPingWaitMs({ lastAt, prev, next, now = Date.now() } = {}) {
  if (!pingAllowed(lastAt, now)) {
    const t = ts(lastAt);
    return Math.max(0, PING_MIN_GAP_MS - (now - t));
  }
  if (!lastAt) return 0;
  const moving = isMoving(prev, next);
  const gap = moving ? PING_MOVING_MS : PING_STATIONARY_MS;
  const t = ts(lastAt);
  return Math.max(0, gap - (now - t));
}

export function shouldPurgePing(ping, share, now = Date.now(), { maxAgeDays = PING_MAX_AGE_DAYS, afterEndDays = PING_AFTER_END_DAYS } = {}) {
  if (!ping) return false;
  const rec = ts(ping.recorded_at);
  if (Number.isFinite(rec) && now - rec >= maxAgeDays * DAY_MS) return true;
  const ended = ts(share?.stopped_at) || (share && !isShareLive(share, now) ? ts(share.expires_at) : NaN);
  if (Number.isFinite(ended) && now - ended >= afterEndDays * DAY_MS) return true;
  return false;
}

export function shouldPurgeLatest(share, now = Date.now(), { afterEndDays = PING_AFTER_END_DAYS } = {}) {
  if (!share) return false;
  const ended = ts(share.stopped_at) || (!isShareLive(share, now) ? ts(share.expires_at) : NaN);
  return Number.isFinite(ended) && now - ended >= afterEndDays * DAY_MS;
}

export function untilLabel(share, now = Date.now(), { locale, timeZone } = {}) {
  if (!share) return '';
  if (share.mode === 'until_off' || !share.expires_at) return 'until you turn it off';
  const exp = ts(share.expires_at);
  if (!Number.isFinite(exp)) return '';
  if (exp <= now) return 'ended';
  try {
    const t = new Date(exp).toLocaleTimeString(locale || 'en-US', { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
    const day = new Date(exp).toLocaleDateString(locale || 'en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
    const today = new Date(now).toLocaleDateString(locale || 'en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
    return day === today ? `until ${t}` : `until ${day}, ${t}`;
  } catch {
    return 'until the chosen time';
  }
}

export function ageLabel(at, now = Date.now()) {
  const t = ts(at);
  if (!Number.isFinite(t)) return 'No location yet';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.floor(m / 60);
  return h === 1 ? 'Updated 1 hour ago' : `Updated ${h} hours ago`;
}

export function publicShareView(share, latest, now = Date.now(), { label } = {}) {
  const v = viewShare(share, now);
  if (!v || !v.live) return null;
  return {
    id: v.id,
    user_id: v.user_id,
    load_id: v.load_id || null,
    mode: v.mode,
    duration_hours: v.duration_hours,
    started_at: v.started_at,
    expires_at: v.expires_at,
    until: untilLabel(v, now),
    auto_stop_on_delivered: !!v.auto_stop_on_delivered,
    label: label || 'Driver',
    load_ref: null,
    lat: latest?.lat ?? null,
    lng: latest?.lng ?? null,
    accuracy_m: latest?.accuracy_m ?? null,
    speed_mps: latest?.speed_mps ?? null,
    heading: latest?.heading ?? null,
    recorded_at: latest?.recorded_at ?? null,
    age: ageLabel(latest?.recorded_at, now),
  };
}

export function cronAuthorized(headerValue, env = {}) {
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) return { ok: false, status: 503, error: 'Location sharing cleanup is off: CRON_SECRET is not set. Nothing was run.', code: 'no_cron_secret' };
  const bearer = String(headerValue || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(bearer, secret)) return { ok: false, status: 401, error: 'Not allowed.', code: 'unauthorized' };
  return { ok: true };
}

function safeEqual(a, b) {
  const left = String(a), right = String(b);
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export function intervalSql(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return null;
  return `${n} days`;
}
