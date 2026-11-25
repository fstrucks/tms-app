// Optional "delete my reviews too" (20261125000100). In-memory Postgres only. Fake rows only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/account_deletion_delete_reviews.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const one = async (sql) => (await db.query(sql)).rows[0];
const n = async (sql) => (await one(sql)).n;

await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
create table public.stops (id uuid primary key default gen_random_uuid(), stop_type text, company_name text, address_line1 text, city text, state text, zip text);
create table public.facility_notes (
  id uuid primary key default gen_random_uuid(), facility_id uuid,
  author_id uuid not null references auth.users(id) on delete cascade, company_id uuid,
  body text not null, hidden boolean not null default false, created_at timestamptz not null default now());
`);
for (const f of ['20261015001200_company_profiles.sql', '20261022190000_facility_reviews.sql', '20261024000200_facility_review_stars_summary.sql',
  '20261028000100_account_deletion.sql', '20261125000100_account_deletion_delete_reviews.sql', '20261125000100_account_deletion_delete_reviews.sql']) {
  await db.exec(readFileSync(R + f, 'utf8')); // the new migration twice: idempotent
}

const FAC = id(500);
await db.exec(`insert into public.facilities (id, key, name) values ('${FAC}', 'k-shared', 'Shared Fake Dock')`);
let seq = 1000;
async function user(u, email) { await db.exec(`insert into auth.users (id, email, last_sign_in_at) values ('${u}', '${email}', '2026-10-01T00:00:00Z')`); }
async function company(c, owner, name) { await db.exec(`insert into public.company_profiles (id, owner_id, legal_name) values ('${c}', '${owner}', '${name}')`); }
async function member(c, u) { await db.exec(`insert into public.company_members (profile_id, user_id, role) values ('${c}', '${u}', 'driver')`); }
async function review(author, companyId, stars, text) {
  const r = id(seq++), s = id(seq++), nId = id(seq++);
  await db.exec(`insert into public.stops (id, stop_type, company_name) values ('${s}', 'pickup', 'Shared Fake Dock');
insert into public.facility_reviews (id, facility_id, stop_id, author_id, company_id, stars, better_note, need_to_know)
  values ('${r}', '${FAC}', '${s}', '${author}', ${companyId ? `'${companyId}'` : 'null'}, ${stars}, '${text}', 'ntk ${text}');
insert into public.facility_notes (id, facility_id, author_id, company_id, body) values ('${nId}', '${FAC}', '${author}', ${companyId ? `'${companyId}'` : 'null'}, 'note ${text}');`);
  return { r, nId };
}
const reviewGone = async (x) => (await n(`select count(*)::int n from public.facility_reviews where id = '${x.r}'`)) === 0 && (await n(`select count(*)::int n from public.facility_notes where id = '${x.nId}'`)) === 0;
const reviewKeptAnon = async (x) => {
  const r = await one(`select author_id, company_id from public.facility_reviews where id = '${x.r}'`);
  const t = await one(`select author_id, company_id from public.facility_notes where id = '${x.nId}'`);
  return !!r && !!t && r.author_id == null && r.company_id == null && t.author_id == null && t.company_id == null;
};
const reviewUntouched = async (x, author) => (await n(`select count(*)::int n from public.facility_reviews where id = '${x.r}' and author_id = '${author}'`)) === 1
  && (await n(`select count(*)::int n from public.facility_notes where id = '${x.nId}' and author_id = '${author}'`)) === 1;
const summary = async () => one(`select avg_stars::float a, review_count c from public.facility_summaries(array['${FAC}'::uuid])`);
const request = async (u, c, kind, del, purgeAfter = "now() - interval '1 day'", baseline = "'2026-10-01T00:00:00Z'") =>
  db.exec(`insert into public.account_deletion_requests (user_id, company_profile_id, kind, purge_after, baseline_sign_in_at, delete_reviews)
    values ('${u}', ${c ? `'${c}'` : 'null'}, '${kind}', ${purgeAfter}, ${baseline}, ${del})`);
const run = async (u) => (await one(`select public.account_deletion_apply_with_reviews('${u}') j`)).j;

// Bystander company with its own driver. Their reviews must never change.
const OTHER_OWNER = id(1), OTHER_CO = id(2), BYSTANDER = id(3);
await user(OTHER_OWNER, 'other-owner@example.test'); await company(OTHER_CO, OTHER_OWNER, 'Other Fake Co');
await user(BYSTANDER, 'bystander@example.test'); await member(OTHER_CO, BYSTANDER);
const bystanderReview = await review(BYSTANDER, OTHER_CO, 4, 'bystander');
const otherOwnerReview = await review(OTHER_OWNER, OTHER_CO, 2, 'other owner');

// Company A: owner, a driver who only belongs to A, and a driver who also belongs to Other Fake Co.
const A_OWNER = id(10), A_CO = id(11), A_ONLY = id(12), A_SHARED = id(13), A_UNCHECKED = id(14), A_CHECKED = id(15);
await user(A_OWNER, 'a-owner@example.test'); await company(A_CO, A_OWNER, 'Fake Co A');
await user(A_ONLY, 'a-only@example.test'); await member(A_CO, A_ONLY);
await user(A_SHARED, 'a-shared@example.test'); await member(A_CO, A_SHARED); await member(OTHER_CO, A_SHARED);
await user(A_UNCHECKED, 'a-unchecked@example.test'); await member(A_CO, A_UNCHECKED);
await user(A_CHECKED, 'a-checked@example.test'); await member(A_CO, A_CHECKED);

// --- Member, unchecked: today's behavior (kept, no name).
const uncheckedR = await review(A_UNCHECKED, A_CO, 1, 'member unchecked');
await request(A_UNCHECKED, null, 'member', false);
const j1 = await run(A_UNCHECKED);
ok(j1.reviews_deleted === 0 && j1.notes_deleted === 0, 'member unchecked: nothing deleted');
ok(await reviewKeptAnon(uncheckedR), 'member unchecked: review and note stay with no name');
ok((await n(`select count(*)::int n from auth.users where id = '${A_UNCHECKED}'`)) === 1, 'function never removes the sign-in itself (server does)');

// --- Member, checked: their reviews + notes go (need-to-know is a column on the review), reports cascade.
const before = await summary();
const checkedR = await review(A_CHECKED, A_CO, 1, 'member checked');
const checkedR2 = await review(A_CHECKED, null, 1, 'member checked no company');
const mid = await summary();
await db.exec(`insert into public.facility_review_reports (review_id, reporter_id, reason) values ('${checkedR.r}', '${BYSTANDER}', 'fake report')`);
ok((await n(`select count(*)::int n from public.facility_review_reports where review_id = '${checkedR.r}'`)) === 1, 'member checked: a report exists before');
await request(A_CHECKED, null, 'member', true);
const j2 = await run(A_CHECKED);
ok(j2.reviews_deleted === 2 && j2.notes_deleted === 2, 'member checked: both reviews and both notes deleted');
ok(await reviewGone(checkedR) && await reviewGone(checkedR2), 'member checked: rows gone, including one with no company');
ok((await n(`select count(*)::int n from public.facility_review_reports where review_id in ('${checkedR.r}', '${checkedR2.r}')`)) === 0, 'member checked: report rows cascade');
ok(await reviewUntouched(bystanderReview, BYSTANDER) && await reviewUntouched(otherOwnerReview, OTHER_OWNER), 'member checked: other users untouched');
const after = await summary();
ok(mid.c === before.c + 2 && after.c === before.c && after.a === before.a, `ratings update (count ${mid.c} -> ${after.c}, avg ${mid.a} -> ${after.a})`);
ok((await n(`select count(*)::int n from public.facilities where id = '${FAC}'`)) === 1, 'facility stays');

// --- Company, cancelled by a later sign-in: nothing deleted even though ticked.
const ownerR = await review(A_OWNER, A_CO, 3, 'owner');
const onlyR = await review(A_ONLY, A_CO, 3, 'a-only in A');
const onlyNoCo = await review(A_ONLY, null, 3, 'a-only no company');
const sharedInA = await review(A_SHARED, A_CO, 3, 'shared in A');
const sharedInOther = await review(A_SHARED, OTHER_CO, 3, 'shared in other');
await request(A_OWNER, A_CO, 'company', true);
await db.exec(`update auth.users set last_sign_in_at = '2026-11-01T00:00:00Z' where id = '${A_OWNER}'`);
const j3 = await run(A_OWNER);
ok(j3.cancelled === true && j3.reviews_deleted === 0, 'company: signing in again cancels and deletes nothing');
ok(await reviewUntouched(ownerR, A_OWNER) && await reviewUntouched(onlyR, A_ONLY), 'company cancelled: reviews still linked');

// --- Company, still in the waiting period: error, and the transaction rolls back.
await request(A_OWNER, A_CO, 'company', true, "now() + interval '3 days'", "'2026-11-01T00:00:00Z'");
let raised = false; try { await run(A_OWNER); } catch (e) { raised = /grace_period/.test(e.message); }
ok(raised && await reviewUntouched(ownerR, A_OWNER), 'company in grace: error, nothing deleted');
await db.exec(`update public.account_deletion_requests set purge_after = now() - interval '1 day' where user_id = '${A_OWNER}' and cancelled_at is null`);

// --- Company, checked: owner + teammates who lose their sign-in + anything written for this company.
const j4 = await run(A_OWNER);
ok(j4.mode === 'company' && j4.reviews_deleted === 4 && j4.notes_deleted === 4, `company checked: 4 reviews + 4 notes deleted (got ${j4.reviews_deleted}/${j4.notes_deleted})`);
ok(await reviewGone(ownerR) && await reviewGone(onlyR) && await reviewGone(onlyNoCo) && await reviewGone(sharedInA), 'company checked: owner, sole-company driver (all theirs), and reviews written for this company are gone');
ok(await reviewUntouched(sharedInOther, A_SHARED), 'company checked: a teammate who keeps their sign-in keeps reviews written for their other company');
ok(await reviewUntouched(bystanderReview, BYSTANDER) && await reviewUntouched(otherOwnerReview, OTHER_OWNER), 'company checked: other companies untouched');
ok((await n(`select count(*)::int n from public.company_profiles where id = '${A_CO}'`)) === 0, 'company checked: company removed as before');
ok((await n(`select count(*)::int n from public.facilities where id = '${FAC}'`)) === 1, 'company checked: facility stays');
const j5 = await run(A_OWNER);
ok(j5.already_applied === true || j5.reviews_deleted === 0, 'running again deletes nothing more');

// --- Company, unchecked: today's behavior.
const B_OWNER = id(20), B_CO = id(21), B_DRIVER = id(22);
await user(B_OWNER, 'b-owner@example.test'); await company(B_CO, B_OWNER, 'Fake Co B');
await user(B_DRIVER, 'b-driver@example.test'); await member(B_CO, B_DRIVER);
const bOwner = await review(B_OWNER, B_CO, 4, 'b owner'); const bDriver = await review(B_DRIVER, B_CO, 4, 'b driver');
await request(B_OWNER, B_CO, 'company', false);
const j6 = await run(B_OWNER);
ok(j6.reviews_deleted === 0 && await reviewKeptAnon(bOwner) && await reviewKeptAnon(bDriver), 'company unchecked: reviews and notes stay with no name');
ok(await reviewUntouched(bystanderReview, BYSTANDER), 'company unchecked: other users untouched');

if (!process.exitCode) console.log('all passed');
