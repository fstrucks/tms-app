// Facility reviews PR 1: anonymous, platform-wide. Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { cleanReview, noteProblem, facilityKey, canReviewStop, recentTips, publicReview, PUBLIC_REVIEW_FIELDS } from '../../app/lib/facilityReviews.js';
import * as REVIEW from '../../app/api/loads/[id]/stops/[stopId]/review/route.js';
import * as LOADFAC from '../../app/api/loads/[id]/facilities/route.js';
import * as FAC from '../../app/api/facilities/[id]/route.js';
import * as REPORT from '../../app/api/facility-reviews/[id]/report/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1', S1 = '00000000-0000-4000-8000-0000000000d1', S2 = '00000000-0000-4000-8000-0000000000d2';
const F1 = '00000000-0000-4000-8000-0000000000f1', R1 = '00000000-0000-4000-8000-0000000000e1';
const SQL = read('../../supabase/migrations/20261022190000_facility_reviews.sql');

test('content filter: phone, email, links, profanity rejected with a clear message; clean notes pass', () => {
  for (const t of ['call 555-123-4567', 'Call (312) 555 0199 at gate', '+1 312.555.0199']) assert.equal(noteProblem(t), 'phone', t);
  assert.equal(noteProblem('ask bob@example.com'), 'email');
  assert.equal(noteProblem('see www.example.com/map'), 'link');
  assert.equal(noteProblem('this place is shit'), 'profanity');
  for (const t of ['Use gate 3 off Hwy 20, door 14-22', 'Vest + hard hat required. Check in at guard shack.', 'Assess parking first', 'Ref 12345 at window']) assert.equal(noteProblem(t), null, t);
  assert.match(cleanReview({ stars: 3, need_to_know: 'call 555-123-4567' }).error, /phone number/);
  assert.equal(cleanReview({ stars: 3, need_to_know: 'call 555-123-4567' }).field, 'need_to_know');
  assert.match(cleanReview({ stars: 0 }).error, /1 to 4/); assert.ok(cleanReview({ stars: 5 }).error); assert.ok(cleanReview({ stars: 2.5 }).error);
  assert.deepEqual(cleanReview({ stars: '4', better_note: '  slow   dock ', need_to_know: '' }).row, { stars: 4, better_note: 'slow dock', need_to_know: null });
});

test('directory key: same facility across companies regardless of case / punctuation / street words', () => {
  const a = facilityKey({ company_name: 'ACME Foods, Inc.', address_line1: '100 Main Street', city: 'Dallas', state: 'TX', zip: '75201-1234' });
  const b = facilityKey({ company_name: 'acme foods inc', address_line1: '100 main st', city: 'DALLAS', state: 'tx', zip: '75201' });
  assert.equal(a, b); assert.equal(facilityKey({ company_name: 'X', address_line1: '' }), null);
  assert.notEqual(a, facilityKey({ company_name: 'ACME Foods', address_line1: '200 Main St', city: 'Dallas', state: 'TX', zip: '75201' }));
});

test('public shape: only stars, notes, dates (and id for Report)', () => {
  assert.deepEqual(PUBLIC_REVIEW_FIELDS, ['id', 'stars', 'better_note', 'need_to_know', 'created_at', 'updated_at']);
  assert.deepEqual(Object.keys(publicReview({ id: 'r', stars: 3, author_id: 'x', company_id: 'y', stop_id: 'z' })), PUBLIC_REVIEW_FIELDS);
  assert.deepEqual(recentTips([{ need_to_know: null }, { need_to_know: 'Gate 3', created_at: 'd' }]), [{ text: 'Gate 3', at: 'd' }]);
  assert.ok(canReviewStop({ stop_type: 'pickup', completion: 'done', facility_id: F1 }));
  assert.ok(!canReviewStop({ stop_type: 'pickup', completion: 'skipped', facility_id: F1 }));
  assert.ok(!canReviewStop({ stop_type: 'pickup', completion: 'done', facility_id: null }));
});

const stop = (id, seq, type, extra = {}) => ({ id, load_id: L1, sequence: seq, stop_type: type, company_name: 'TEST Shipper', completed_at: null, completion: null, facility_id: F1, ...extra });
function ctx(role, userId, { stops, reviews = [], reports = [] } = {}) {
  const svc = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, status: 'in_transit', broker_name: 'Fake Broker', assigned_driver_user_id: DRIVER }],
    stops: stops || [stop(S1, 1, 'pickup', { completed_at: '2026-10-20T18:00:00Z', completion: 'done' }), stop(S2, 2, 'delivery')],
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }], facilities: [{ id: F1, name: 'TEST Shipper', city: 'Dallas', state: 'TX' }],
    facility_reviews: reviews, facility_review_reports: reports }, unique: { facility_review_reports: [{ cols: ['review_id', 'reporter_id'] }] } });
  const from = svc.from.bind(svc);
  svc.from = (t) => { const q = from(t); if (t === 'loads') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data) r.data = { ...r.data, stops: svc.db.stops.filter((s) => s.load_id === r.data.id) }; return r; }; } return q; };
  // The public functions: the fake returns exactly what the SQL returns (no author / company / stop / load fields).
  svc.rpc = async (fn, a) => {
    const vis = svc.db.facility_reviews.filter((r) => !r.hidden);
    if (fn === 'facility_summaries') return { data: svc.db.facilities.filter((f) => a.p_ids.includes(f.id)).map((f) => { const rs = vis.filter((r) => r.facility_id === f.id); return { facility_id: f.id, name: f.name, city: f.city, state: f.state, avg_stars: rs.length ? rs.reduce((x, r) => x + r.stars, 0) / rs.length : null, review_count: rs.length }; }), error: null };
    if (fn === 'facility_public_reviews') return { data: vis.filter((r) => r.facility_id === a.p_facility).map(({ id, stars, better_note, need_to_know, created_at, updated_at }) => ({ id, stars, better_note, need_to_know, created_at, updated_at })), error: null };
    return { data: null, error: null };
  };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  const urpc = uc.rpc.bind(uc); uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === OWNER ? role : null, error: null }) : urpc(fn, a));
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const rq = (method, body) => new Request('http://x', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const call = async (mod, m, c, params, body) => { const r = await mod[m](rq(m, body), { params, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('review: driver reviews a picked-up stop, edits it (one per stop per user); open stop / other driver refused; filter on server', async () => {
  const c = ctx('driver', DRIVER);
  let r = await call(REVIEW, 'GET', c, { id: L1, stopId: S1 }); assert.equal(r.j.review, null); assert.equal(r.j.canReview, true);
  r = await call(REVIEW, 'PUT', c, { id: L1, stopId: S1 }, { stars: 3, need_to_know: 'Check in at guard shack, vest required' });
  assert.equal(r.status, 200); assert.equal(c.svc.db.facility_reviews.length, 1);
  assert.equal(c.svc.db.facility_reviews[0].author_id, DRIVER); assert.equal(c.svc.db.facility_reviews[0].company_id, 'p1'); assert.equal(c.svc.db.facility_reviews[0].hidden ?? false, false);
  r = await call(REVIEW, 'PUT', c, { id: L1, stopId: S1 }, { stars: 2, better_note: 'Slow dock' });
  assert.equal(r.status, 200); assert.equal(c.svc.db.facility_reviews.length, 1); assert.equal(c.svc.db.facility_reviews[0].stars, 2);
  assert.ok(!('author_id' in r.j.review) && !('company_id' in r.j.review));
  r = await call(REVIEW, 'PUT', c, { id: L1, stopId: S1 }, { stars: 2, better_note: 'email me at x@example.com' }); assert.equal(r.status, 422);
  r = await call(REVIEW, 'PUT', c, { id: L1, stopId: S2 }, { stars: 4 }); assert.equal(r.status, 409, 'not delivered yet');
  r = await call(REVIEW, 'PUT', ctx('driver', OTHER), { id: L1, stopId: S1 }, { stars: 4 }); assert.equal(r.status, 404);
});

test('stop card + facility page: averages, count, tips; anonymous; hidden excluded; any signed-in user can read the facility', async () => {
  const reviews = [
    { id: R1, facility_id: F1, stop_id: S1, author_id: OWNER, company_id: 'p1', stars: 4, need_to_know: 'Gate 3', created_at: '2026-10-21T00:00:00Z', hidden: false },
    { id: 'r2', facility_id: F1, stop_id: 'other', author_id: OTHER, company_id: 'p9', stars: 2, better_note: 'slow', created_at: '2026-10-20T00:00:00Z', hidden: false },
    { id: 'r3', facility_id: F1, stop_id: 'x', author_id: OTHER, company_id: 'p9', stars: 1, need_to_know: 'HIDDEN', created_at: '2026-10-22T00:00:00Z', hidden: true },
  ];
  let r = await call(LOADFAC, 'GET', ctx('driver', DRIVER, { reviews }), { id: L1 });
  assert.equal(r.j.facilities[S1].count, 2); assert.equal(r.j.facilities[S1].avg, 3); assert.deepEqual(r.j.facilities[S1].tips.map((t) => t.text), ['Gate 3']);
  r = await call(FAC, 'GET', ctx('driver', OTHER, { reviews }), { id: F1 });
  assert.equal(r.status, 200); assert.equal(r.j.reviews.length, 2);
  const text = JSON.stringify(r.j);
  for (const leak of [OWNER, OTHER, 'p1', 'p9', S1, L1, 'Fake Broker', 'FAKE Trucking', 'HIDDEN', 'author_id', 'company_id', 'stop_id']) assert.ok(!text.includes(leak), `no ${leak}`);
});

test('report: stored once per user per review; hidden / unknown review 404', async () => {
  const reviews = [{ id: R1, facility_id: F1, stop_id: S1, author_id: OWNER, stars: 4, hidden: false }];
  const c = ctx('driver', OTHER, { reviews });
  let r = await call(REPORT, 'POST', c, { id: R1 }, { reason: 'TEST wrong place' }); assert.equal(r.status, 200);
  r = await call(REPORT, 'POST', c, { id: R1 }, {}); assert.equal(r.status, 200);
  assert.equal(c.svc.db.facility_review_reports.length, 1); assert.equal(c.svc.db.facility_review_reports[0].reporter_id, OTHER);
  r = await call(REPORT, 'POST', ctx('driver', OTHER, { reviews: [{ ...reviews[0], hidden: true }] }), { id: R1 }, {}); assert.equal(r.status, 404);
});

test('migration: shared directory, trigger link, no client access to reviews/reports, safe definer reads exclude hidden', () => {
  assert.match(SQL, /create table if not exists public\.facilities/); assert.match(SQL, /key text not null unique/);
  assert.match(SQL, /create trigger stops_link_facility before insert or update of company_name, address_line1, city, state, zip, stop_type on public\.stops/);
  assert.match(SQL, /unique \(stop_id, author_id\)/); assert.match(SQL, /stars smallint not null check \(stars between 1 and 4\)/);
  assert.match(SQL, /hidden boolean not null default false/);
  assert.match(SQL, /revoke all on public\.facility_reviews from authenticated/); assert.match(SQL, /revoke all on public\.facility_review_reports from authenticated/);
  assert.ok(!/create policy \w+ on public\.facility_reviews/.test(SQL), 'no client policies on reviews');
  const pub = SQL.slice(SQL.indexOf('create or replace function public.facility_public_reviews'));
  assert.match(pub, /returns table \(id uuid, stars smallint, better_note text, need_to_know text, created_at timestamptz, updated_at timestamptz\)/);
  assert.match(pub, /and not r\.hidden/); assert.match(SQL, /left join public\.facility_reviews r on r\.facility_id = f\.id and not r\.hidden/);
  assert.ok(!/^\s*(update|insert into|delete from) public\.(stops|facilities|loads)\b(?![\s\S]{0,40}values \(v_key)/im.test(SQL.replace(/insert into public\.facilities \(key[^;]+;/, '')), 'no backfill');
});

test('UI wiring: prompt after picked up / delivered, dismissible; facility info on the stop card; facility page with Report', () => {
  const a = read('../../app/components/StopActions.js');
  assert.match(a, /if \(action === 'done' && !r\.already && \['pickup', 'delivery'\]\.includes\(stop\.stop_type\)\) setReviewStop/);
  assert.match(a, /<FacilityInfo info=\{facilities\[target\.id\]\} \/>/);
  const f = read('../../app/components/FacilityReview.js');
  assert.match(f, /facility-review-dismiss/); assert.match(f, /What could be better \(optional\)/); assert.match(f, /Need to know \(optional\)/); assert.match(f, /without your name or company/);
  const p = read('../../app/facilities/[id]/page.js');
  assert.match(p, /facility-report/); assert.ok(!/author|company_id/.test(p));
});
