// Shipper / receiver star rating on the Reviews tab. Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toggleStars, rateStarLabel, ratedStarLabel, starUpdate, reviewParties, partyLabel, STARS_MAX } from '../../app/lib/facilityReviews.js';

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
  assert.match(list, /<StarRating value=\{r\.stars\} readOnly/);
});
