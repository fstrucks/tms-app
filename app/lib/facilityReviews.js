// Facility reviews (PR 1): anonymous, platform-wide. Pure helpers (browser, server and tests).
import { parseUtc } from './packetDate';
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

// One rating's taps. Each tap is applied to the latest optimistic value, and
// saves run one at a time so a slower earlier save cannot overwrite a newer one.
// A second tap that would put back the star currently being cleared is ignored:
// a rapid double tap on the selected star stays cleared, and the saved value matches.
export function createStarTaps({ initial = 0, save } = {}) {
  let value = starValue(initial);
  let saved = value;
  let desired = value;
  let error = null;
  let chain = Promise.resolve();
  let pumping = false;

  function pump() {
    if (pumping || typeof save !== 'function') return;
    if (desired === saved) return;
    pumping = true;
    chain = chain.then(async () => {
      try {
        while (desired !== saved) {
          const target = desired;
          try {
            const written = starValue(await save(target));
            if (desired !== target) {
              saved = written;
              continue;
            }
            saved = written;
            value = written;
            desired = written;
            error = null;
          } catch (e) {
            if (desired !== target) continue;
            error = e?.message || 'Couldn’t save your rating.';
            value = saved;
            desired = saved;
          }
        }
      } finally {
        pumping = false;
        if (desired !== saved) pump();
      }
    });
  }

  function done() {
    const seen = chain;
    return seen.then(() => (chain !== seen || desired !== saved ? done() : { value, error }));
  }

  return {
    get value() { return value; },
    get error() { return error; },
    push(next) {
      const n = starValue(next);
      // The clear has not been saved yet. Tapping that same star again is the
      // second half of a double tap, still aimed at the star that was selected.
      if (n > 0 && desired === 0 && saved !== 0 && n === saved) {
        value = 0;
        return 0;
      }
      value = n;
      desired = n;
      error = null;
      pump();
      return value;
    },
    reset(next) {
      if (desired !== saved) return; // a tap is already ahead of the server copy
      const v = starValue(next);
      value = v;
      desired = v;
      saved = v;
      error = null;
    },
    done,
  };
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
// "3.5 ★ (12 ratings)", or "No ratings yet". A null star is not a rating, so count is the rated count.
export function ratingSummary(avg, count) {
  const n = Number(count) || 0;
  const num = Number(avg);
  if (!n || avg == null || avg === '' || !Number.isFinite(num) || num < 1) return 'No ratings yet';
  return `${num.toFixed(1)} ★ (${n} rating${n === 1 ? '' : 's'})`;
}
const REVIEW_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function reviewDateLabel(iso, timeZone) {
  if (!iso) return '';
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return m >= 1 && m <= 12 && d ? `${REVIEW_MONTHS[m - 1]} ${d}, ${y}` : '';
  }
  const t = parseUtc(s);
  if (Number.isNaN(t.getTime())) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-US', timeZone ? { ...opts, timeZone } : opts).format(t);
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(t);
  }
}
// "Dropoff · Jul 14, 2026". Pickup and delivery only. No reviewer name.
export function reviewVisitLabel(review) {
  const kind = review?.stop_type === 'pickup' ? 'Pickup' : review?.stop_type === 'delivery' ? 'Dropoff' : '';
  const date = reviewDateLabel(review?.created_at);
  return [kind, date].filter(Boolean).join(' · ');
}
// When the loaded list is the whole set, recompute so a null star cannot slip in as 0.
// A full page (length === cap) may be truncated, so the server average stands.
export function displaySummary(avg, count, reviews, cap = 200) {
  if (Array.isArray(reviews) && reviews.length < cap) return summarizeStars(reviews);
  const n = Number(count) || 0;
  const num = avg == null || avg === '' ? null : Number(avg);
  return { avg: num == null || !Number.isFinite(num) ? null : num, count: n };
}
// Null, blank, and anything outside 1–4 is unrated. It is left out of the average and the count,
// never coerced to 0. [4, null, 2] → average 3, count 2. Same rule as facility_summaries.
export function summarizeStars(values) {
  const rated = [];
  for (const raw of values || []) {
    const v = raw && typeof raw === 'object' ? raw.stars : raw;
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > STARS_MAX) continue;
    rated.push(n);
  }
  if (!rated.length) return { avg: null, count: 0 };
  return { avg: Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10, count: rated.length };
}
export const starsText = (n) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > STARS_MAX) return '';
  return '★'.repeat(v) + '☆'.repeat(STARS_MAX - v);
};
// Recent non-empty Need-to-know tips (newest first) from public reviews.
export const recentTips = (reviews, n = 3) => (reviews || []).filter((r) => r.need_to_know).slice(0, n).map((r) => ({ text: r.need_to_know, at: r.updated_at || r.created_at }));
// Only these fields ever go to another user. stop_type is pickup or delivery, never a name.
export const PUBLIC_REVIEW_FIELDS = ['id', 'stars', 'better_note', 'need_to_know', 'created_at', 'updated_at', 'stop_type'];
const VISIT_KIND = new Set(['pickup', 'delivery']);
export function publicReview(r) {
  const out = Object.fromEntries(PUBLIC_REVIEW_FIELDS.map((k) => [k, r?.[k] ?? null]));
  out.stop_type = VISIT_KIND.has(r?.stop_type) ? r.stop_type : null;
  return out;
}

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
