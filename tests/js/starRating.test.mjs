// Shipper / receiver star rating on the Reviews tab. Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toggleStars, rateStarLabel, ratedStarLabel, starUpdate, reviewParties, partyLabel, summarizeStars, starsText, ratingSummary, reviewVisitLabel, displaySummary, STARS_MAX } from '../../app/lib/facilityReviews.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('toggleStars: tap sets 1 to 4, tapping the current star clears it', () => {
  assert.equal(STARS_MAX, 4);
  assert.equal(toggleStars(0, 1), 1);
  assert.equal(toggleStars(0, 3), 3);
  assert.equal(toggleStars(3, 3), 0);
  assert.equal(toggleStars(2, 4), 4);
  assert.equal(toggleStars(4, 4), 0);
  assert.equal(toggleStars(1, 5), 1);
  assert.equal(toggleStars(2, 0), 2);
  assert.equal(toggleStars(null, 4), 4);
});

test('star labels for the rating control and the read-only list', () => {
  assert.equal(rateStarLabel(1), 'Rate 1 of 4');
  assert.equal(rateStarLabel(3), 'Rate 3 of 4');
  assert.equal(rateStarLabel(4), 'Rate 4 of 4');
  assert.equal(ratedStarLabel(3), 'Rated 3 of 4');
  assert.equal(ratedStarLabel(0), 'Not rated');
  assert.equal(ratedStarLabel(null), 'Not rated');
});

test('starUpdate: 1–4 saves, 0 or null clears, notes stay when omitted, bad notes rejected', () => {
  assert.deepEqual(starUpdate({ stars: 3 }).row, { stars: 3 });
  assert.deepEqual(starUpdate({ stars: '4', better_note: '  slow   dock ' }).row, { stars: 4, better_note: 'slow dock' });
  assert.equal(starUpdate({ stars: null, need_to_know: 'Gate 3' }).row.stars, null);
  assert.equal(starUpdate({ stars: 0 }).row.stars, null);
  assert.equal(starUpdate({ stars: '' }).row.stars, null);
  assert.ok(!('better_note' in starUpdate({ stars: 2 }).row), 'omitted notes are not wiped');
  assert.match(starUpdate({ stars: 2, better_note: 'call 555-123-4567' }).error, /phone number/);
  assert.match(starUpdate({ stars: 5 }).error, /1 to 4/);
  assert.match(starUpdate({ stars: 2.5 }).error, /1 to 4/);
});

test('summarizeStars: null is unrated, not zero — [4, null, 2] averages 3 with a count of 2', () => {
  assert.deepEqual(summarizeStars([4, null, 2]), { avg: 3, count: 2 });
  assert.deepEqual(summarizeStars([{ stars: 4 }, { stars: null }, { stars: 2 }]), { avg: 3, count: 2 });
  assert.deepEqual(summarizeStars([4, 0, 2]), { avg: 3, count: 2 });
  assert.deepEqual(summarizeStars([null, null]), { avg: null, count: 0 });
  assert.deepEqual(summarizeStars([]), { avg: null, count: 0 });
  assert.equal(summarizeStars([1, 2, 4]).avg, 2.3);
});

test('rating summary: null stars stay out — [4, null, 3] is 3.5 with 2 ratings', () => {
  const s = summarizeStars([4, null, 3]);
  assert.deepEqual(s, { avg: 3.5, count: 2 });
  assert.equal(ratingSummary(s.avg, s.count), '3.5 ★ (2 ratings)');
  assert.equal(ratingSummary(4, 1), '4.0 ★ (1 rating)');
  assert.equal(ratingSummary(3.5, 12), '3.5 ★ (12 ratings)');
  assert.equal(ratingSummary(null, 0), 'No ratings yet');
  assert.equal(ratingSummary(0, 3), 'No ratings yet');
  assert.deepEqual(displaySummary(2, 3, [{ stars: 4 }, { stars: null }, { stars: 2 }]), { avg: 3, count: 2 });
  assert.deepEqual(displaySummary(3.5, 12, Array.from({ length: 200 }, () => ({ stars: 4 }))), { avg: 3.5, count: 12 });
});

test('visit label is pickup or dropoff plus the date, never a name', () => {
  assert.equal(reviewVisitLabel({ stop_type: 'delivery', created_at: '2026-07-14T18:00:00Z', author_id: 'x' }), 'Dropoff · Jul 14, 2026');
  assert.equal(reviewVisitLabel({ stop_type: 'pickup', created_at: '2026-10-02T15:00:00Z' }), 'Pickup · Oct 2, 2026');
  assert.equal(reviewVisitLabel({ stop_type: 'other', created_at: '2026-07-14T18:00:00Z' }), 'Jul 14, 2026');
  assert.equal(reviewVisitLabel({ stars: null, stop_type: 'pickup' }), 'Pickup');
});

test('unrated display is Not rated, never 0 stars or Rated 0 of 4', () => {
  assert.equal(ratedStarLabel(0), 'Not rated');
  assert.equal(ratedStarLabel(null), 'Not rated');
  assert.equal(starsText(null), '');
  assert.equal(starsText(0), '');
  assert.equal(starsText(3), '★★★☆');
  const ui = read('../../app/components/StarRating.js');
  assert.match(ui, /Not rated/);
  assert.ok(!ui.includes('Rated 0 of 4'));
  assert.match(ui, /if \(readOnly && !filled\)/);
  const list = read('../../app/facilities/[id]/page.js');
  assert.match(list, /<PublicReviewCard /);
  assert.match(read('../../app/components/ReviewSummary.js'), /<StarRating value=\{review\?\.stars\} readOnly/);
  const stops = read('../../app/loads/[id]/page.js');
  assert.match(stops, /my_stars > 0 &&/);
});

test('summary SQL counts only non-null stars', () => {
  const sql = read('../../supabase/migrations/20261024000200_facility_review_stars_summary.sql');
  assert.match(sql, /create or replace function public\.facility_summaries/);
  assert.match(sql, /avg\(r\.stars\) filter \(where r\.stars is not null\)/);
  assert.match(sql, /count\(r\.stars\)/);
  assert.ok(!/count\(r\.id\)/.test(sql));
  const visit = read('../../supabase/migrations/20261024000300_facility_review_visit_kind.sql');
  assert.match(visit, /drop function if exists public\.facility_public_reviews\(uuid, integer\)/);
  assert.match(visit, /stop_type text/);
  assert.match(visit, /s\.stop_type in \('pickup', 'delivery'\)/);
  assert.match(visit, /grant execute on function public\.facility_public_reviews\(uuid, integer\) to authenticated/);
  assert.ok(!/author_id/.test(visit));
  assert.ok(!/company_name/.test(visit));
});

test('review parties are the shipper and the receiver, in stop order', () => {
  const stops = [
    { id: 'd', sequence: 2, stop_type: 'delivery', company_name: 'TEST Grocery' },
    { id: 'p', sequence: 1, stop_type: 'pickup', company_name: 'TEST Foods' },
    { id: 'x', sequence: 3, stop_type: 'other', company_name: 'Skip' },
  ];
  assert.deepEqual(reviewParties(stops).map((s) => s.id), ['p', 'd']);
  assert.equal(partyLabel(stops[1]), 'Shipper');
  assert.equal(partyLabel(stops[0]), 'Receiver');
  assert.deepEqual(reviewParties(null), []);
});

test('migration reuses facility_reviews.stars and allows null with a 1–4 check', () => {
  const sql = read('../../supabase/migrations/20261024000100_facility_review_stars_nullable.sql');
  assert.match(sql, /alter table public\.facility_reviews alter column stars drop not null/);
  assert.match(sql, /check \(stars is null or stars between 1 and 4\)/);
  assert.match(sql, /facility_reviews_stars_check/);
  assert.ok(!/create policy/i.test(sql), 'RLS policies stay as they are');
  assert.ok(!/grant /i.test(sql), 'no new client grants');
  assert.ok(!/user_id/i.test(sql));
  const original = read('../../supabase/migrations/20261022190000_facility_reviews.sql');
  assert.match(original, /stars smallint not null check \(stars between 1 and 4\)/);
});

test('Reviews tab and star control: 44px targets, Rate N of 4, clear on a second tap, read-only list', () => {
  const stars = read('../../app/components/StarRating.js');
  assert.match(stars, /aria-label=\{rateStarLabel\(n\)\}/);
  assert.match(stars, /width: 44/);
  assert.match(stars, /height: 44/);
  assert.match(stars, /minWidth: 44/);
  assert.match(stars, /minHeight: 44/);
  assert.match(stars, /toggleStars/);
  assert.match(stars, /ratedStarLabel/);
  const tab = read('../../app/components/LoadReviews.js');
  assert.match(tab, /data-testid="load-reviews"/);
  assert.match(tab, /Shipper/);
  assert.match(tab, /Receiver/);
  assert.match(tab, /<StarRating/);
  const page = read('../../app/loads/[id]/page.js');
  assert.match(page, /\['reviews', 'Reviews'\]/);
  assert.match(page, /data-testid="stop-my-rating"/);
  const prompt = read('../../app/components/FacilityReview.js');
  assert.match(prompt, /<StarRating/);
  const list = read('../../app/facilities/[id]/page.js');
  assert.match(list, /<PublicReviewCard /);
  assert.match(stars, /var\(--star\)/);
  assert.match(tab, /data-testid="review-list"/);
  assert.match(tab, /RatingSummaryRow/);
  assert.match(read('../../app/components/ReviewSummary.js'), /minHeight: 44/);
});
