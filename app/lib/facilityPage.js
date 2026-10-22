// Facility page v2: pure helpers (browser, server and tests) for wait times, facility notes, ratings on stop cards
// and the Open in Maps link.
import { noteProblem } from './facilityReviews.js';

export const FACILITY_NOTE_MAX = 300;
export const MIN_SAMPLES = 3; // mirror of public.facility_wait_stats: smaller buckets are hidden
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const NOTE_ROLES = new Set(['owner', 'management', 'dispatcher', 'driver']);
export const canAddFacilityNote = (role) => NOTE_ROLES.has(role);

const WHY = {
  phone: 'Please remove the phone number. Notes are public, so contact details aren’t allowed.',
  email: 'Please remove the email address. Notes are public, so contact details aren’t allowed.',
  link: 'Please remove the web link.',
  profanity: 'Please keep it clean: remove the profanity and save again.',
};
// Client body → { row: { body } } | { error }
export function cleanFacilityNote(body = {}) {
  const t = String(body?.body ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { error: 'Write a note first.' };
  if (t.length > FACILITY_NOTE_MAX) return { error: `Keep it to ${FACILITY_NOTE_MAX} characters.` };
  const p = noteProblem(t); if (p) return { error: WHY[p], reason: p };
  return { row: { body: t } };
}
export const PUBLIC_NOTE_FIELDS = ['id', 'body', 'created_at'];
export const publicNote = (n) => Object.fromEntries(PUBLIC_NOTE_FIELDS.map((k) => [k, n?.[k] ?? null]));

// Rows from facility_wait_stats → { samples, avg, hourly: [{ bucket, label, avg, samples }], daily: [...] }.
// Buckets under MIN_SAMPLES are dropped here too (defense in depth).
export function shapeWaitStats(rows) {
  const ok = (r) => Number(r.samples) >= MIN_SAMPLES && r.avg_minutes != null;
  const all = (rows || []).find((r) => r.kind === 'all');
  const pick = (kind, label) => (rows || []).filter((r) => r.kind === kind && ok(r)).sort((a, b) => a.bucket - b.bucket)
    .map((r) => ({ bucket: r.bucket, label: label(r.bucket), avg: Number(r.avg_minutes), samples: Number(r.samples) }));
  return {
    samples: Number(all?.samples || 0),
    avg: all && ok(all) ? Number(all.avg_minutes) : null,
    hourly: pick('hour', hourLabel),
    daily: pick('dow', (d) => DAYS[d] || String(d)),
  };
}
export function hourLabel(h) { const n = h % 12 || 12; return `${n}${h < 12 ? 'a' : 'p'}`; }
export function fmtMinutes(m) {
  if (m == null || !Number.isFinite(Number(m))) return '';
  const v = Math.round(Number(m)); if (v < 60) return `${v} min`;
  const h = Math.floor(v / 60), r = v % 60; return r ? `${h} hr ${r} min` : `${h} hr`;
}

// "3.2★ · 5 reviews", or null when there are no reviews.
export function ratingText(info) {
  if (!info || !info.count || info.avg == null) return null;
  return `${Number(info.avg).toFixed(1)}★ · ${info.count} review${info.count === 1 ? '' : 's'}`;
}

export function facilityAddress(f) {
  if (!f) return '';
  const cityState = [f.city, [f.state, f.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [f.address_line1, cityState].filter(Boolean).join(', ');
}
// Google Maps search link (no API key). Uses name + address so a name-only facility still finds something.
export function mapsUrl(f) {
  const q = [f?.name, facilityAddress(f)].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}
