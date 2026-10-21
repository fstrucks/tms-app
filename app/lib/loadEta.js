// Home card Panel 2 (map + miles left + drive time + ETA), Marc Oct 18 2026. Pure helpers shared by the browser
// and the server route (app/api/loads/[id]/eta). No driver location is ever stored or logged: the browser keeps the
// latest fix in memory only, and the server rounds it (ORIGIN_DECIMALS) before it goes to OpenRouteService.
import { sortedStops } from './loadTabs';

// Same text as fullAddress() in loads.js (that file has JSX, so it isn't imported here; loadRoute.js does the same).
const fullAddress = (stop) => {
  if (!stop) return '';
  const line3 = [[stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' ');
  return [stop.address_line1, stop.address_line2, line3].filter(Boolean).join(', ');
};

// ---- refresh / caching rules (plan 2026-10-18_current-load-eta_plan.md §1) ----
export const LOCATION_POLL_MS = 60_000;          // read location once a minute while Panel 2 is showing
export const AGE_TICK_MS = 15_000;               // longest gap between re-renders of "Updated N min ago" / the estimate while Panel 2 is showing (QA #96)
export const LOCATING_MAX_MS = 30_000;           // "Finding your location…" never shows longer than this (backstop if the browser never answers)
export const REFRESH_MIN_MOVE_MI = 10;           // re-route after moving ≥ 10 mi …
export const REFRESH_MIN_GAP_MS = 10 * 60_000;   // … and ≥ 10 min since the last route
export const PERIODIC_MS = 20 * 60_000;          // or every 20 min while moving at all
export const PERIODIC_MIN_MOVE_MI = 0.5;
export const MANUAL_FLOOR_MS = 2 * 60_000;       // Refresh button floor
export const NEAR_STOP_MI = 1;                   // "At or near the stop": no more routing
export const MAX_ACCURACY_M = 2_000;             // coarser fixes are still shown + routed, flagged "approximate" (QA #118)
export const MAX_FIX_AGE_MS = 5 * 60_000;
export const LAST_GOOD_MAX_MS = 60 * 60_000;     // show the last good answer (with its age) up to 60 min
export const ERROR_RETRY_MS = 10 * 60_000;       // timeout / busy / quota
export const NO_ROUTE_MOVE_MI = 2;               // no_route (e.g. a yard off the network): retry after moving 2 mi
export const ORIGIN_DECIMALS = 2;                // ≈ 0.7 mi; Marc OK'd sending this to HeiGIT (Oct 18, 9:49 PM CT)

// ---- server-side limits ----
export const SERVER_CACHE_TTL_MS = 10 * 60_000;
export const SERVER_CACHE_MAX = 500;
export const USER_MIN_GAP_MS = 3 * 60_000;       // ≤ 1 ORS call per user every 3 min (cache hits don't count)
export const USER_PER_DAY = 60;
export const ETA_LIMITS = { eta: { perMinute: 20, perDay: 1200 } }; // inside the shared directions headroom
export const ORS_ETA_TIMEOUT_MS = 8_000;

const R_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
export function haversineMi(a, b) {
  if (!a || !b || ![a.lat, a.lng, b.lat, b.lng].every((v) => v != null && v !== '' && Number.isFinite(Number(v)))) return null;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hasCoords = (s) => !!s && s.lat != null && s.lng != null && s.lat !== '' && s.lng !== '' && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng));

export const roundCoord = (v, d = ORIGIN_DECIMALS) => { const f = 10 ** d; return Math.round(Number(v) * f) / f; };

// Validate the POST body. → { lat, lng, accuracy } | null. Never echoes the input in errors or logs.
export function parseOrigin(body) {
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (body?.lat === null || body?.lng === null || body?.lat === '' || body?.lng === '') return null;
  const acc = Number(body?.accuracy_m);
  return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? acc : null };
}

// A browser fix we can show and route from: real coordinates, not stale. QA #118 (Taylor, desktop Wi-Fi/IP location):
// fixes coarser than 2 km used to be dropped silently (no marker, no miles). Now they're used and flagged instead.
export function fixUsable(fix, now = Date.now()) {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return false;
  if (fix.at != null && now - fix.at > MAX_FIX_AGE_MS) return false;
  return true;
}
export const VERY_ROUGH_MI = 50;
export const isCoarseFix = (fix) => !!fix && fix.accuracy != null && fix.accuracy > MAX_ACCURACY_M;
// "Approximate location (within about 12 mi)". null for a precise fix.
export function coarseFixNote(fix) {
  if (!isCoarseFix(fix)) return null;
  const mi = Math.max(1, Math.round(fix.accuracy / 1609.344)); // meters → miles (correct; desktop IP fixes can be ±1,000+ mi)
  if (mi > VERY_ROUGH_MI) return 'Very rough location (from your network, not GPS), so miles and drive time left may be off.';
  return `Approximate location (within about ${mi.toLocaleString('en-US')} mi), so miles and drive time left are rough.`;
}

// Should the browser ask the server for a new route? → { go, reason }
// last = { origin:{lat,lng}, at, stopId } | null; block = { until?, noRouteAt?:{lat,lng} } | null
export function shouldRefresh({ last, fix, stop, now = Date.now(), manual = false, block = null }) {
  if (!fixUsable(fix, now)) return { go: false, reason: 'no_fix' };
  if (!hasCoords(stop)) return { go: false, reason: 'no_stop' };
  const toStop = haversineMi(fix, stop);
  if (toStop != null && toStop <= NEAR_STOP_MI) return { go: false, reason: 'near_stop' };
  if (block?.noRouteAt) {
    const m = haversineMi(fix, block.noRouteAt);
    if (m != null && m < NO_ROUTE_MOVE_MI) return { go: false, reason: 'no_route_wait' };
  }
  if (block?.until && now < block.until) return { go: false, reason: 'cooldown' };
  if (!last || last.stopId !== stop.id) return { go: true, reason: last ? 'stop_changed' : 'first' };
  const gap = now - last.at;
  if (manual) return gap >= MANUAL_FLOOR_MS ? { go: true, reason: 'manual' } : { go: false, reason: 'manual_floor' };
  const moved = haversineMi(fix, last.origin) ?? 0;
  if (moved >= REFRESH_MIN_MOVE_MI && gap >= REFRESH_MIN_GAP_MS) return { go: true, reason: 'moved' };
  if (gap >= PERIODIC_MS && moved >= PERIODIC_MIN_MOVE_MI) return { go: true, reason: 'periodic' };
  return { go: false, reason: moved < PERIODIC_MIN_MOVE_MI ? 'stationary' : 'wait' };
}

// Between routing calls: scale the last answer by straight-line progress toward the stop (no API call).
export function estimate(last, fix, stop) {
  if (!last || !Number.isFinite(last.miles)) return null;
  const was = haversineMi(last.origin, stop), now = fix ? haversineMi(fix, stop) : null;
  let k = 1;
  if (was && was > 0.1 && now != null) k = Math.max(0, Math.min(1.5, now / was));
  const miles = Math.max(0, Math.round(last.miles * k));
  const seconds = last.seconds == null ? null : Math.max(0, Math.round(last.seconds * k));
  return { miles, seconds, scaled: k !== 1 };
}

export function fmtDriveTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} m` : `${h} h`;
}

export const fmtMilesLeft = (mi) => (mi == null ? null : `${Number(mi).toLocaleString('en-US')} mi`);

export function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// ETA = now + drive time, in the stop's zone when known, else the device's. → "Tue 3:10 AM MST"
export function fmtEta(now, seconds, tz) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const at = new Date(now + seconds * 1000);
  const opts = { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  if (validTz(tz)) opts.timeZone = tz;
  return new Intl.DateTimeFormat('en-US', opts).format(at).replace(',', '');
}

// "to delivery" / "to pickup" / "to stop 2 of 4"
export function etaTarget(load, index) {
  const st = sortedStops(load);
  const s = st[index];
  if (!s) return '';
  if (st.length > 2) return `to stop ${index + 1} of ${st.length}`;
  return s.stop_type === 'pickup' ? 'to pickup' : s.stop_type === 'delivery' ? 'to delivery' : 'to the stop';
}

// Fallback number: the current calculated route, else Planned miles.
export function totalRouteMiles(load, view) {
  const c = Number(view?.calculated_miles);
  if (c > 0) return c;
  const t = Number(view?.total_miles ?? load?.total_miles);
  return t > 0 ? t : null;
}

// QA #96 r2: the next re-render lands right after the next whole minute since the fix (so "1 min ago" flips at
// exactly +60 s, not up to a tick later), and never later than AGE_TICK_MS (the estimate and ETA keep moving).
export function nextAgeTickMs(at, now = Date.now(), { max = AGE_TICK_MS, slack = 50 } = {}) {
  if (!at || !(now >= at)) return max;
  const toMinute = 60_000 - ((now - at) % 60_000);
  return Math.max(slack, Math.min(max, toMinute + slack));
}

export function ageText(at, now = Date.now()) {
  if (!at) return null;
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return 'Updated just now';
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.floor(m / 60);
  return `Updated ${h} h ago`;
}

// ---- Navigate buttons (Trucker Path, Google Maps, Apple Maps) + Copy address ----
// Google Maps URLs (documented): https://developers.google.com/maps/documentation/urls/get-started
// Apple Map Links (documented): https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html
// Trucker Path URL Launcher Schema (documented, coordinates only, no addresses):
//   https://helpcenter.truckerpath.com/hc/en-us/articles/38761044344205-Using-the-Trucker-Path-URL-Launcher-Schema
//   iOS truckerpath://cal_route?daddr=LAT,LNG · Android truckerpath://cal_route?d_addr=LAT,LNG (start = current location)
export const TP_APP_STORE = 'https://apps.apple.com/us/app/trucker-path-truck-gps-fuel/id782746890';
export const TP_PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.sixdays.truckerpath';
export const TP_PACKAGE = 'com.sixdays.truckerpath';
export const TP_FALLBACK_MS = 1_500;

export function platformOf(ua = '', { maxTouchPoints = 0 } = {}) {
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios'; // iPadOS reports Mac
  return 'desktop';
}

export const stopAddress = (stop) => fullAddress(stop) || [stop?.company_name, stop?.city, stop?.state].filter(Boolean).join(', ');

const ll = (s) => `${Number(s.lat).toFixed(6)},${Number(s.lng).toFixed(6)}`;

export function googleMapsUrl(stop) {
  const a = stopAddress(stop);
  if (!a && !hasCoords(stop)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a || ll(stop))}&travelmode=driving`;
}
export function appleMapsUrl(stop) {
  const a = stopAddress(stop);
  if (!a && !hasCoords(stop)) return null;
  return `https://maps.apple.com/?daddr=${encodeURIComponent(a || ll(stop))}&dirflg=d`;
}
// → { href, fallback } | null. Android uses Chrome's intent: URL with a Play Store fallback built in; iOS opens the
// custom scheme and the page sends the driver to the App Store if the app didn't open. Desktop: none (phone app).
export function truckerPathLink(stop, platform) {
  if (!hasCoords(stop)) return null;
  if (platform === 'android') {
    return { href: `intent://cal_route?d_addr=${ll(stop)}#Intent;scheme=truckerpath;package=${TP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(TP_PLAY_STORE)};end`, fallback: null };
  }
  if (platform === 'ios') return { href: `truckerpath://cal_route?daddr=${ll(stop)}`, fallback: TP_APP_STORE };
  return null;
}

// ---- browser → server call (fetch and token injected for tests) ----
export async function postEta({ url, body, fetchImpl = fetch, getToken }) {
  let authRetried = false;
  for (let n = 0; n < 2; n++) {
    let res, j;
    try {
      res = await fetchImpl(url, { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${await getToken(authRetried)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      j = await res.json().catch(() => null);
    } catch { return { state: 'error', code: 'network', retryInMs: ERROR_RETRY_MS }; }
    if (res.status === 401 && !authRetried) { authRetried = true; continue; }
    if (j) return j;
    return { state: 'error', code: 'upstream', retryInMs: ERROR_RETRY_MS };
  }
  return { state: 'error', code: 'auth', message: 'Your sign-in expired. Please sign in again.' };
}

export const ETA_ERROR_TEXT = {
  rate_limited: 'Live miles are paused for a bit (route limit). Showing the last known numbers.',
  timeout: 'The route service didn’t answer. It will try again in a few minutes.',
  upstream: 'Live miles unavailable right now.',
  network: 'Couldn’t reach PowerHaul. It will try again in a few minutes.',
  no_route: 'No truck route from here yet. It will try again after you move a bit.',
  no_key: null, // the live line is just hidden
  no_stop_location: 'The next stop has no map location yet. Check its address on the load.',
  user_limit: 'Live miles refresh at most every few minutes.',
};
