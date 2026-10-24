// Facility reviews (PR 1): anonymous, platform-wide. Pure helpers (browser, server and tests).
// Content rules: 1–4 stars; two optional notes ("What could be better", "Need to know"), 500 characters each.
// Notes may not contain phone numbers, email addresses, web links or profanity: the review is rejected with a
// message saying what to remove (nothing is silently changed, so the driver knows what was posted).
export const STARS_MAX = 4;
export const NOTE_MAX = 500;
export const STAR_LABELS = { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Great' };
export const NEED_TO_KNOW_HINT = 'Route or entrance, where to check in, PPE / vest, parking, hours…';

const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const LINK = /\b(?:https?:\/\/|www\.)\S+/i;
// Short, conservative list; matched as whole words (letters only), so e.g. "Scunthorpe" or "assess" pass.
const PROFANITY = ['fuck', 'fucking', 'fucker', 'shit', 'shitty', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'motherfucker', 'slut', 'whore'];
const PROF_RE = new RegExp(`\\b(?:${PROFANITY.join('|')})\\b`, 'i');

// → null | 'phone' | 'email' | 'link' | 'profanity'
export function noteProblem(text) {
  const t = String(text || '');
  if (!t) return null;
  if (EMAIL.test(t)) return 'email';
  if (LINK.test(t)) return 'link';
  if (PHONE.test(t)) return 'phone';
  if (PROF_RE.test(t.replace(/[^A-Za-z\s]/g, ' '))) return 'profanity';
  return null;
}
const WHY = {
  phone: 'Please remove the phone number. Reviews are public, so contact details aren’t allowed.',
  email: 'Please remove the email address. Reviews are public, so contact details aren’t allowed.',
  link: 'Please remove the web link.',
  profanity: 'Please keep it clean: remove the profanity and save again.',
};
const clip = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, NOTE_MAX) : null; };

// Client body → { row: { stars, better_note, need_to_know } } | { error, field }
export function cleanReview(body = {}) {
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > STARS_MAX) return { error: 'Pick 1 to 4 stars.', field: 'stars' };
  const better = clip(body.better_note), need = clip(body.need_to_know);
  for (const [field, v] of [['better_note', better], ['need_to_know', need]]) {
    const p = noteProblem(v); if (p) return { error: WHY[p], field, reason: p };
  }
  return { row: { stars, better_note: better, need_to_know: need } };
}

// Reviews tab: set 1–4, or clear (null / 0 / ''). Notes are updated only when the body includes them,
// so a star tap does not wipe a note the client didn't send.
export function starUpdate(body = {}) {
  const raw = body?.stars;
  const clearing = raw === null || raw === 0 || raw === '' || raw === '0';
  const stars = clearing ? null : Number(raw);
  if (!clearing && (!Number.isInteger(stars) || stars < 1 || stars > STARS_MAX)) return { error: 'Pick 1 to 4 stars.', field: 'stars' };
  const row = { stars };
  for (const field of ['better_note', 'need_to_know']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const v = clip(body[field]);
    const p = noteProblem(v);
    if (p) return { error: WHY[p], field, reason: p };
    row[field] = v;
  }
  return { row };
}

const starValue = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= STARS_MAX ? n : 0;
};
// Tap a star to set it. Tap the current star again to clear (0 until it is saved as null).
export function toggleStars(current, tapped) {
  const n = Number(tapped);
  if (!Number.isInteger(n) || n < 1 || n > STARS_MAX) return starValue(current);
  const cur = starValue(current);
  return cur === n ? 0 : n;
}
export const rateStarLabel = (n) => `Rate ${n} of ${STARS_MAX}`;
export const ratedStarLabel = (n) => (starValue(n) ? `Rated ${starValue(n)} of ${STARS_MAX}` : 'Not rated');

// Pickups and deliveries, in stop order: the shipper and the receiver on a load.
export function reviewParties(stops) {
  return (stops || [])
    .filter((s) => s && (s.stop_type === 'pickup' || s.stop_type === 'delivery'))
    .slice()
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || String(a.id).localeCompare(String(b.id)));
}
export const partyLabel = (stop) => (stop?.stop_type === 'pickup' ? 'Shipper' : stop?.stop_type === 'delivery' ? 'Receiver' : 'Stop');

// Stops that can be reviewed: picked up / delivered (not skipped), linked to a facility.
export const isReviewableStop = (s) => !!s && ['pickup', 'delivery'].includes(s.stop_type) && s.completion === 'done';
export const canReviewStop = (s) => isReviewableStop(s) && !!s.facility_id;
// A done stop with no facility yet can be linked on demand when it has a name plus a city or ZIP
// (mirror of public.facility_link_stop / facility_resolve, migration 20261022230000). The name is company_name, or
// address_line1 when company_name is empty and address_line1 has no digits (e.g. 'Acme Dock').
export const canLinkStop = (s) => isReviewableStop(s) && !s.facility_id && facilityLooseKey(s) != null;
// What the review prompt should show for a stop: 'review' | 'link' (linked when the review is saved) | 'missing' (empty state) | null (not yet).
export function reviewState(s) {
  if (!isReviewableStop(s)) return null;
  if (s.facility_id) return 'review';
  return canLinkStop(s) ? 'link' : 'missing';
}
export const NO_FACILITY_MSG = 'This stop needs a facility name and a city or ZIP before it can be reviewed. Add them on the stop, then try again.';
export const fmtStars = (avg) => (avg == null ? '' : `${Number(avg).toFixed(1)}★`);
export const starsText = (n) => '★'.repeat(n) + '☆'.repeat(Math.max(0, STARS_MAX - n));
// Recent non-empty Need-to-know tips (newest first) from public reviews.
export const recentTips = (reviews, n = 3) => (reviews || []).filter((r) => r.need_to_know).slice(0, n).map((r) => ({ text: r.need_to_know, at: r.updated_at || r.created_at }));
// Only these fields ever go to another user (the public functions return the same set).
export const PUBLIC_REVIEW_FIELDS = ['id', 'stars', 'better_note', 'need_to_know', 'created_at', 'updated_at'];
export const publicReview = (r) => Object.fromEntries(PUBLIC_REVIEW_FIELDS.map((k) => [k, r?.[k] ?? null]));

// JS mirror of public.facility_key (migration 20261022190000), for docs / tests.
export function facilityNorm(p) {
  return String(p || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd').replace(/\bdrive\b/g, 'dr')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bhighway\b/g, 'hwy').replace(/\s+/g, ' ').trim();
}
export function facilityKey(s) {
  const n = facilityNorm(s?.company_name), l = facilityNorm(s?.address_line1), c = facilityNorm(s?.city), z = String(s?.zip || '').replace(/\D/g, '').slice(0, 5);
  if (!n || !l || (!c && !s?.zip)) return null;
  return [n, l, c, facilityNorm(s?.state), z].join('|');
}

// JS mirror of public.facility_stop_name (migration 20261022230000).
export function facilityStopName(s) {
  if (facilityNorm(s?.company_name)) return String(s.company_name).trim();
  const l = String(s?.address_line1 || '');
  return facilityNorm(l) && !/[0-9]/.test(l) ? l.trim() : null;
}
// JS mirror of public.facility_loose_key: name|''|city|state|zip5, null without a name or without both city and ZIP.
export function facilityLooseKey(s) {
  const name = facilityStopName(s), c = facilityNorm(s?.city), z = String(s?.zip || '').replace(/\D/g, '');
  if (!name || (!c && !z)) return null;
  return [facilityNorm(name), '', c, facilityNorm(s?.state), z.slice(0, 5)].join('|');
}
