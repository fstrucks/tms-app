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

// Stops that can be reviewed: picked up / delivered (not skipped), linked to a facility.
export const isReviewableStop = (s) => !!s && ['pickup', 'delivery'].includes(s.stop_type) && s.completion === 'done';
export const canReviewStop = (s) => isReviewableStop(s) && !!s.facility_id;
// A done stop with no facility yet can be linked on demand when it has a name plus a city or ZIP
// (mirror of public.facility_link_stop, migration 20261022210000).
export const canLinkStop = (s) => isReviewableStop(s) && !s.facility_id && !!facilityNorm(s.company_name) && !!(facilityNorm(s.city) || String(s.zip || '').replace(/\D/g, ''));
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
