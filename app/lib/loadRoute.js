// PR B (Marc, Oct 18): load map + calculated truck miles with OpenRouteService (HeiGIT) and a Leaflet/OpenStreetMap map.
// Pure helpers shared by the server route (app/lib/loadRouteServer.js), the map card and tests. No network here.
//  * Stops are geocoded once and cached on stops (lat, lng, geocoded_at, geocode_address, geocode_precision).
//  * The driving-hgv route is cached on loads (calculated_miles, route_key, route_geometry, route_computed_at, route_error).
//    route_key is a fingerprint of the stop addresses: ORS is only called again when an address changes
//    (or after a cool-down for a temporary failure). Never on a plain page view.
//  * Planned miles precedence (Marc, Oct 18): typed > rate con > calculated. Calculated miles only fill
//    loads.total_miles when it's empty or already 'calculated'.

// Same text as fullAddress() in loads.js (that file has JSX, so it isn't imported here).
const fullAddress = (stop) => {
  if (!stop) return '';
  const line3 = [[stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' ');
  return [stop.address_line1, stop.address_line2, line3].filter(Boolean).join(', ');
};

export const ORS_BASE = 'https://api.heigit.org';
export const ORS_GEOCODE_PATH = '/pelias/v1/search';                 // ORS geocoding (Pelias) on api.heigit.org
export const ORS_GEOCODE_STRUCTURED_PATH = '/pelias/v1/search/structured';
export const ORS_DIRECTIONS_PATH = '/openrouteservice/v2/directions/driving-hgv';
export const MAX_ROUTE_STOPS = 25;           // ORS allows 50 waypoints; a load never needs this many
export const MISMATCH_RATIO = 0.10;          // "Calculated N mi · Use this" when rate con and route differ by more
export const MAX_GEOMETRY_POINTS = 400;      // stored route line is simplified to about this many points
export const RETRY_AFTER_MS = { rate_limited: 10 * 60_000, upstream: 10 * 60_000, timeout: 10 * 60_000, bad_key: 60 * 60_000 };
// Permanent for the same addresses (only an address change retries): geocode_miss, no_route.
export const PERMANENT_ERRORS = new Set(['geocode_miss', 'no_route']);

// Free plan (HeiGIT standard): directions 2,000/day and 40/min; geocoding 1,000/day and 100/min.
// We stay under them with headroom (several app instances may run at once).
export const LIMITS = {
  directions: { perMinute: 30, perDay: 1800 },
  geocode: { perMinute: 80, perDay: 900 },
};

export const ROUTE_COLS = ['calculated_miles', 'route_key', 'route_geometry', 'route_computed_at', 'route_error'];
export const STOP_GEO_COLS = ['lat', 'lng', 'geocoded_at', 'geocode_address', 'geocode_precision'];
export const hasRouteColumns = (row) => !!row && Object.prototype.hasOwnProperty.call(row, 'calculated_miles');
export const hasStopGeoColumns = (stop) => !!stop && Object.prototype.hasOwnProperty.call(stop, 'lat');

const norm = (s) => String(s ?? '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();

// The text that is geocoded for a stop and stored in geocode_address. '' when the stop has nothing usable.
export const stopAddressText = (stop) => norm(fullAddress(stop));

// Stops used for the route, in sequence order (pickups and deliveries; anything with an address).
export function routeStops(stops) {
  return [...(stops || [])]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .filter((s) => stopAddressText(s))
    .slice(0, MAX_ROUTE_STOPS);
}

// FNV-1a 32-bit, twice (different seeds) → 16 hex chars. Same in the browser and on the server.
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export function routeKey(stops) {
  const parts = routeStops(stops).map(stopAddressText);
  if (parts.length < 2) return null;
  const s = 'v1|' + parts.join('|');
  return fnv(s, 2166136261) + fnv(s, 3166136261);
}

// Does this stop need a (new) geocode? Yes when it was never found, or its address changed since.
export const needsGeocode = (stop) => !!stopAddressText(stop) && (stop.lat == null || stop.lng == null || stop.geocode_address !== stopAddressText(stop));

const CA_PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);
export const stopCountry = (stop) => (CA_PROVINCES.has(String(stop?.state || '').toUpperCase()) ? 'CA' : 'US');

// Geocode attempts for a stop, best first: the street address, then city/state/zip. → [{ path, params, precision }]
export function geocodeAttempts(stop) {
  const country = stopCountry(stop);
  const out = [];
  const cityLine = [[stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' ');
  if (stop.address_line1) {
    out.push({ path: ORS_GEOCODE_PATH, precision: 'street',
      params: { text: [stop.address_line1, stop.address_line2, cityLine].filter(Boolean).join(', '), 'boundary.country': country, size: '1' } });
  }
  if (stop.city || stop.zip) {
    const p = { country, size: '1' };
    if (stop.city) p.locality = stop.city;
    if (stop.state) p.region = stop.state;
    if (stop.zip) p.postalcode = String(stop.zip);
    out.push({ path: ORS_GEOCODE_STRUCTURED_PATH, precision: 'city', params: p });
  }
  return out;
}

const STREET_LAYERS = new Set(['address', 'venue', 'street']);
const CITY_LAYERS = new Set(['locality', 'localadmin', 'postalcode', 'borough', 'neighbourhood', 'county', 'macrocounty']);
// Pick the point from a Pelias FeatureCollection, or null. Rejects a wrong-state match and low-confidence hits.
export function pickGeocode(json, stop, precision) {
  const f = json?.features?.[0];
  const c = f?.geometry?.coordinates;
  if (!f || !Array.isArray(c) || c.length < 2) return null;
  const [lng, lat] = c.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const p = f.properties || {};
  const layers = precision === 'street' ? STREET_LAYERS : CITY_LAYERS;
  if (p.layer && !layers.has(p.layer)) return null;
  if (precision === 'street' && p.confidence != null && Number(p.confidence) < 0.7) return null;
  const st = String(stop?.state || '').toUpperCase();
  if (st && p.region_a && String(p.region_a).toUpperCase() !== st) return null;
  return { lat, lng, precision, label: p.label || null };
}

// ---- Encoded polyline (precision 5, what ORS returns by default) ----
export function decodePolyline(str, precision = 5) {
  if (!str || typeof str !== 'string') return [];
  const f = 10 ** precision;
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let res = 0, shift = 0, b;
    do {
      if (i >= str.length) return null;
      b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5;
    } while (b >= 0x20);
    return res & 1 ? ~(res >> 1) : res >> 1;
  };
  while (i < str.length) {
    const dLat = next(); const dLng = next();
    if (dLat == null || dLng == null) break;
    lat += dLat; lng += dLng;
    pts.push([lat / f, lng / f]);
  }
  return pts;
}
export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let out = '', pLat = 0, pLng = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1, s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const [la, ln] of points) {
    const a = Math.round(la * f), b = Math.round(ln * f);
    out += enc(a - pLat) + enc(b - pLng); pLat = a; pLng = b;
  }
  return out;
}

// Douglas-Peucker (planar; fine for drawing a line). Raises the tolerance until it fits maxPoints.
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let k = s + 1; k < e; k++) {
      const [px, py] = pts[k];
      let d;
      if (!len) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
        d = (px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2;
      }
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > t2 && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, k) => keep[k]);
}
export function simplifyLine(points, maxPoints = MAX_GEOMETRY_POINTS) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  let tol = 0.0005, out = points;
  for (let n = 0; n < 20 && out.length > maxPoints; n++) { out = dp(points, tol); tol *= 2; }
  return out;
}

// Directions JSON → { miles, geometry } | null. units=mi, so summary.distance is miles.
export function parseDirections(json) {
  const r = json?.routes?.[0];
  const d = Number(r?.summary?.distance);
  if (!r || !Number.isFinite(d) || d <= 0) return null;
  const miles = Math.max(1, Math.round(d));
  const pts = typeof r.geometry === 'string' ? decodePolyline(r.geometry) : [];
  return { miles, geometry: pts.length ? encodePolyline(simplifyLine(pts)) : null };
}

// ORS failure → short code stored in loads.route_error.
export function classifyOrsError({ status = null, body = null, timedOut = false } = {}) {
  if (timedOut) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'bad_key';
  const code = Number(body?.error?.code);
  // 2009 route not found, 2010 point not found (not routable), 2004 limits exceeded (distance etc.)
  if (code === 2009 || code === 2010 || code === 2004) return 'no_route';
  if (status === 400 || status === 404) return 'no_route';
  return 'upstream';
}

export const ERROR_TEXT = {
  no_key: 'The map and route miles aren’t set up yet.',
  setup: 'The map needs a database update that hasn’t been applied yet.',
  geocode_miss: 'Couldn’t find {stops} on the map. Check the address.',
  no_route: 'Couldn’t find a truck route between these stops.',
  rate_limited: 'The map service is busy. The route will be tried again in a few minutes.',
  upstream: 'The map service didn’t answer. The route will be tried again in a few minutes.',
  timeout: 'The map service didn’t answer. The route will be tried again in a few minutes.',
  bad_key: 'The map service key was rejected. The route will be tried again later.',
  too_few: 'Add a pickup and a delivery address to see the route.',
};

// Is the cached route current for these stops? → { fresh, retryInMs }
export function routeFreshness(load, stops, now = Date.now()) {
  const key = routeKey(stops);
  if (!key) return { fresh: true, key: null, reason: 'too_few' };
  if (load?.route_key !== key) return { fresh: false, key, reason: 'changed' };
  if (stops.some(needsGeocode) && !PERMANENT_ERRORS.has(load.route_error)) return { fresh: false, key, reason: 'stops' };
  if (!load.route_error) return { fresh: true, key };
  if (PERMANENT_ERRORS.has(load.route_error)) return { fresh: true, key };
  const wait = RETRY_AFTER_MS[load.route_error] ?? 10 * 60_000;
  const at = load.route_computed_at ? Date.parse(load.route_computed_at) : 0;
  const left = at + wait - now;
  return left > 0 ? { fresh: true, key, retryInMs: left } : { fresh: false, key, reason: 'retry' };
}

// Patch for loads after a successful route. Planned (total_miles) only when it's empty or already calculated,
// and only once miles_source exists (PR A migration), so a calculated value is never mistaken for a typed one.
export function calculatedMilesPatch(load, miles) {
  const patch = { calculated_miles: miles };
  const sourceKnown = !!load && Object.prototype.hasOwnProperty.call(load, 'miles_source');
  if (sourceKnown && miles > 0 && (load.total_miles == null || load.miles_source === 'calculated')) {
    patch.total_miles = miles; patch.miles_source = 'calculated';
  }
  return patch;
}

// "Calculated N mi · Use this": rate con miles and route miles differ by more than 10%, and Planned isn't the
// calculated number already. → { miles, diffPct } | null
export function calculatedHint({ load, rateConMiles }) {
  const calc = Number(load?.calculated_miles);
  const rc = Number(rateConMiles);
  if (!(calc > 0) || !(rc > 0)) return null;
  if (Number(load?.total_miles) === calc) return null;
  const diff = Math.abs(calc - rc) / rc;
  return diff > MISMATCH_RATIO ? { miles: calc, diffPct: Math.round(diff * 100) } : null;
}

// Per-instance sliding window (minute + UTC day). Serverless instances don't share it, so LIMITS has headroom,
// and the server also counts recent route attempts in the database when it can.
export function createLimiter(limits = LIMITS, nowFn = () => Date.now()) {
  const hits = {};
  return {
    take(kind, n = 1) {
      const lim = limits[kind]; if (!lim) return true;
      const now = nowFn(), day = new Date(now).toISOString().slice(0, 10);
      const h = (hits[kind] ||= { day, dayCount: 0, minute: [] });
      if (h.day !== day) { h.day = day; h.dayCount = 0; }
      h.minute = h.minute.filter((t) => now - t < 60_000);
      if (h.minute.length + n > lim.perMinute || h.dayCount + n > lim.perDay) return false;
      for (let k = 0; k < n; k++) h.minute.push(now);
      h.dayCount += n;
      return true;
    },
    peek: (kind) => hits[kind],
  };
}

// Client-side: stops for pins + decoded line, from the API response.
export const PIN_LABEL = (s, i, n) => (s.stop_type === 'pickup' ? 'P' : s.stop_type === 'delivery' ? 'D' : i === 0 ? 'P' : i === n - 1 ? 'D' : String(i + 1));
