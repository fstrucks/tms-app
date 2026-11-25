// Share-only sending key for the phone app (background location). Pure helpers: no network, no React.
// Unit-tested in tests/js/locationShareDevice.test.mjs.
//
// Why a separate key: in the background the web page's 1-hour sign-in token stops renewing, and Supabase refresh tokens
// are single-use, so the native layer must not share them. When a share starts in the app, the signed-in page asks for a
// key that can do exactly one thing: add points to that one share while it is live. Only a SHA-256 hash is stored.
// The key dies when the share ends (any reason), when a new key is issued for the share, or at its own expiry.
import { createHash, randomBytes } from 'node:crypto';
import { PING_MIN_GAP_MS } from './locationShare.js';

export const DEVICE_KEY_PREFIX = 'phsk_';
export const DEVICE_KEY_HEADER = 'x-share-key';
export const DEVICE_KEY_RE = /^phsk_[A-Za-z0-9_-]{43}$/;      // prefix + 32 random bytes, base64url
export const DEVICE_KEY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;    // until-off shares: the app asks for a fresh key when opened
export const DEVICE_PING_REQUEST_GAP_MS = 10_000;             // one upload per key every 10 s at most
export const DEVICE_PING_MAX_POINTS = 50;                     // per upload (queued points from a dead zone)
export const DEVICE_POINT_MAX_AGE_MS = 24 * 3600 * 1000;      // queued points older than a day are dropped
export const DEVICE_POINT_FUTURE_SKEW_MS = 2 * 60_000;        // phone clock ahead by up to 2 min is clamped to now
export { PING_MIN_GAP_MS };

const ts = (v) => (v == null || v === '' ? NaN : typeof v === 'number' ? v : Date.parse(v));

export function newDeviceKey(rand = randomBytes) {
  return DEVICE_KEY_PREFIX + Buffer.from(rand(32)).toString('base64url');
}

export function hashDeviceKey(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex');
}

// Reads the key from the X-Share-Key header. Never accepts it from the body or the query string (those end up in logs).
export function readDeviceKey(req) {
  const raw = req?.headers?.get?.(DEVICE_KEY_HEADER);
  const key = String(raw || '').trim();
  return DEVICE_KEY_RE.test(key) ? key : null;
}

// Key expiry: the share's own end time, capped at 7 days from issue.
export function deviceKeyExpiry(share, now = Date.now()) {
  const cap = now + DEVICE_KEY_MAX_AGE_MS;
  const exp = ts(share?.expires_at);
  return new Date(Number.isFinite(exp) ? Math.min(exp, cap) : cap).toISOString();
}

// → { ok: true } | { ok: false, status, code }
export function checkDeviceKeyRow(row, now = Date.now()) {
  if (!row || row.revoked_at) return { ok: false, status: 401, code: 'bad_key' };
  const exp = ts(row.expires_at);
  if (!Number.isFinite(exp) || exp <= now) return { ok: false, status: 401, code: 'key_expired' };
  return { ok: true };
}

export function requestTooSoon(lastUsedAt, now = Date.now(), gapMs = DEVICE_PING_REQUEST_GAP_MS) {
  const t = ts(lastUsedAt);
  if (!Number.isFinite(t)) return 0;
  const wait = gapMs - (now - t);
  return wait > 0 ? wait : 0;
}

const num = (v) => (v == null || v === '' ? null : Number(v));

// One raw point → a clean point, or null when it can't be used. recorded_at may be ISO or epoch ms (the plugin gives ms).
export function cleanPoint(raw, share, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat ?? raw.latitude), lng = Number(raw.lng ?? raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let t = ts(raw.recorded_at ?? raw.time);
  if (!Number.isFinite(t)) t = now;
  if (t > now + DEVICE_POINT_FUTURE_SKEW_MS) return null;
  if (t > now) t = now;
  const started = ts(share?.started_at);
  const floor = Math.max(now - DEVICE_POINT_MAX_AGE_MS, Number.isFinite(started) ? started - 60_000 : -Infinity);
  if (t < floor) return null;
  const stopped = ts(share?.stopped_at);
  if (Number.isFinite(stopped) && t > stopped) return null;
  const exp = ts(share?.expires_at);
  if (Number.isFinite(exp) && t > exp) return null;
  let accuracy_m = num(raw.accuracy_m ?? raw.accuracy);
  let speed_mps = num(raw.speed_mps ?? raw.speed);
  let heading = num(raw.heading ?? raw.bearing);
  if (accuracy_m != null && !(accuracy_m >= 0)) accuracy_m = null;
  if (speed_mps != null && !(speed_mps >= 0)) speed_mps = null;
  if (heading != null && !(heading >= 0 && heading < 360)) heading = null;
  return { lat, lng, accuracy_m, speed_mps, heading, t };
}

// Accepts { points: [...] } or a single point at the top level. → { points, rejected } | { error, status, code }
export function parseDeviceBody(body, share, now = Date.now()) {
  if (!body || typeof body !== 'object') return { error: 'Bad request.', status: 400 };
  const list = Array.isArray(body.points) ? body.points : [body];
  if (list.length > DEVICE_PING_MAX_POINTS) return { error: 'Too many points in one upload.', status: 413, code: 'too_many' };
  const points = [];
  let rejected = 0;
  for (const raw of list) {
    const p = cleanPoint(raw, share, now);
    if (p) points.push(p); else rejected += 1;
  }
  points.sort((a, b) => a.t - b.t);
  return { points, rejected };
}

// Same 20 s floor as the browser path, applied by each point's own time (queued points keep their spacing).
export function thinPoints(points, lastStoredAt, floorMs = PING_MIN_GAP_MS) {
  let last = ts(lastStoredAt);
  const keep = [];
  let skipped = 0;
  for (const p of points) {
    if (Number.isFinite(last) && p.t - last < floorMs) { skipped += 1; continue; }
    keep.push(p);
    last = p.t;
  }
  return { keep, skipped };
}
