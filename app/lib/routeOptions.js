// Route options, Phase 1 (display only). Pure helpers shared by the server (app/lib/routeOptionsServer.js) and the
// browser (app/components/RouteOptions.js). Fastest is the stored route and stays the default; picking another
// option changes only the drawn line and the miles/time shown on that card. Planned miles, RPM, logged miles, IFTA,
// Home ETA and miles left all keep using the fastest route.
import { decodePolyline } from './loadRoute.js';
import { haversineMi, fmtDriveTime } from './loadEta.js';

// Order = chip order. Fastest comes from the stored route; the other two are one ORS call each (all stops at once).
export const VARIANTS = [
  { id: 'fastest', label: 'Fastest', body: null },
  { id: 'shortest', label: 'Shortest', body: { preference: 'shortest' } },
  { id: 'no_tolls', label: 'No tolls', body: { preference: 'fastest', options: { avoid_features: ['tollways'] } } },
];
export const VARIANT_IDS = VARIANTS.map((v) => v.id);
export const labelOf = (id) => VARIANTS.find((v) => v.id === id)?.label || id;

// Two routes are "the same" when miles are within 0.5%, drive time within 1% (when both are known) AND the lines
// match: same polyline, or at least 95% of sampled points of each line lie within 0.25 mi of the other line.
export const SAME = { milesPct: 0.005, secondsPct: 0.01, nearMi: 0.25, nearShare: 0.95, samples: 60 };

const within = (a, b, pct) => Math.abs(a - b) <= pct * Math.max(Math.abs(a), Math.abs(b));

function sample(points, n) {
  if (points.length <= n) return points;
  const out = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round((i * (points.length - 1)) / (n - 1))]);
  return out;
}
// Distance from p to segment a-b, in miles (flat approximation, fine at this scale).
function segDistMi(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * k, ay = a[0] - p[0], bx = (b[1] - p[1]) * k, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y) * 69.0;
}
function nearShare(from, to) {
  if (!from.length || to.length < 1) return 0;
  let hit = 0;
  for (const p of from) {
    let best = Infinity;
    if (to.length === 1) best = haversineMi({ lat: p[0], lng: p[1] }, { lat: to[0][0], lng: to[0][1] });
    for (let i = 1; i < to.length && best > SAME.nearMi; i++) best = Math.min(best, segDistMi(p, to[i - 1], to[i]));
    if (best <= SAME.nearMi) hit++;
  }
  return hit / from.length;
}
export function sameLine(ga, gb) {
  if (!ga || !gb) return false;
  if (ga === gb) return true;
  const a = decodePolyline(ga), b = decodePolyline(gb);
  if (a.length < 2 || b.length < 2) return false;
  return nearShare(sample(a, SAME.samples), b) >= SAME.nearShare && nearShare(sample(b, SAME.samples), a) >= SAME.nearShare;
}
export function sameRoute(a, b) {
  if (!a || !b || !(a.miles > 0) || !(b.miles > 0)) return false;
  if (!within(a.miles, b.miles, SAME.milesPct)) return false;
  if (a.seconds != null && b.seconds != null && !within(a.seconds, b.seconds, SAME.secondsPct)) return false;
  return sameLine(a.geometry, b.geometry);
}

// routes: [{ id, miles, seconds, geometry }] in VARIANTS order (missing/failed ones left out).
// → [{ id, ids, label, miles, seconds, geometry }]; a duplicate joins the first matching option ("Fastest · No tolls")
// and lends it a drive time when that one has none (the stored fastest route has no time saved).
export function mergeOptions(routes) {
  const out = [];
  for (const r of routes) {
    const hit = out.find((o) => sameRoute(o, r));
    if (hit) { hit.ids.push(r.id); if (hit.seconds == null && r.seconds != null) hit.seconds = r.seconds; continue; }
    out.push({ id: r.id, ids: [r.id], miles: r.miles, seconds: r.seconds ?? null, geometry: r.geometry });
  }
  return out.map((o) => ({ ...o, label: o.ids.map(labelOf).join(' · ') }));
}

// ---- browser helpers ----
export const OPTIONS_TEXT = {
  hint: 'Navigation apps pick their own route.',
  homeNote: 'ETA uses the fastest route.',
  onlyOne: 'Only one route found for these stops.',
  loading: 'Finding route options…',
  offline: 'You’re offline. Route options need a connection.',
  failed: 'Couldn’t load route options. Try again.',
  busy: 'Route options are busy right now. Try again in a few minutes.',
  notReady: 'Route options show once the truck route is ready.',
  partial: (names) => `${names} isn’t available right now.`,
};
export const fmtOptionMiles = (m) => (m > 0 ? `${Math.round(m).toLocaleString('en-US')} mi` : '—');
export const chipDetail = (o) => [fmtOptionMiles(o.miles), fmtDriveTime(o.seconds)].filter(Boolean).join(' · ');
export const announceText = (o) => `${o.label} selected, ${fmtOptionMiles(o.miles)}${fmtDriveTime(o.seconds) ? `, drive time ${fmtDriveTime(o.seconds)}` : ''}.`;
// Arrow keys move and select (radio group pattern); wraps around.
export function nextIndex(i, key, n) {
  if (!n) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (i + 1) % n;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return i;
}
// API reply → what the panel shows. { kind: 'hidden'|'loading'|'offline'|'error'|'busy'|'not_ready'|'one'|'list', ... }
export function viewOfReply(j, { online = true } = {}) {
  if (!online) return { kind: 'offline', text: OPTIONS_TEXT.offline };
  if (!j) return { kind: 'loading', text: OPTIONS_TEXT.loading };
  if (j.state === 'no_key' || j.state === 'hidden') return { kind: 'hidden' };
  if (j.state === 'busy') return { kind: 'busy', text: j.message || OPTIONS_TEXT.busy };
  if (j.state === 'not_ready') return { kind: 'not_ready', text: OPTIONS_TEXT.notReady };
  if (j.state !== 'ready' || !Array.isArray(j.options) || !j.options.length) return { kind: 'error', text: j?.message || OPTIONS_TEXT.failed };
  const failed = (j.failed || []).map((f) => labelOf(f.id));
  const partial = failed.length ? OPTIONS_TEXT.partial(failed.join(' and ')) : null;
  if (j.options.length === 1) return { kind: 'one', text: failed.length ? null : OPTIONS_TEXT.onlyOne, partial, options: j.options };
  return { kind: 'list', options: j.options, partial };
}

// Options for RouteMap: null unless there's a real choice (2+ lines). pick = the picked option, null = Fastest.
export function mapOptions(opts, pick) {
  if (!Array.isArray(opts) || opts.length < 2) return null;
  return opts.map((o) => ({ id: o.id, geometry: o.geometry, selected: pick ? o.id === pick.id : (o.ids || [o.id]).includes('fastest') }));
}
