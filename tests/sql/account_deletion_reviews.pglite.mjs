// Facility reviews survive account_deletion_apply. In-memory Postgres only. Fake rows only.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/account_deletion_reviews.pglite.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

await db.exec(`
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
create table public.stops (
  id uuid primary key default gen_random_uuid(),
  stop_type text,
  company_name text,
  address_line1 text,
  city text,
  state text,
  zip text
);
create table public.facility_notes (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid,
  author_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid,
  body text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(readFileSync(R + '20261022190000_facility_reviews.sql', 'utf8'));
await db.exec(readFileSync(R + '20261028000100_account_deletion.sql', 'utf8'));

const MEMBER = id(1), BOSS = id(2), LIVE = id(3), DEMO = id(4);
const C_MEMBER = id(11), C_LIVE = id(12), C_DEMO = id(13);

async function place(userId, email, companyId, name, demo, reviewId, noteId, facilityId, stopId, text) {
  await db.exec(`insert into auth.users (id, email, last_sign_in_at) values ('${userId}', '${email}', '2026-10-01T00:00:00Z');
insert into public.company_profiles (id, owner_id, legal_name, is_demo) values ('${companyId}', '${userId}', '${name}', ${demo});
insert into public.facilities (id, key, name) values ('${facilityId}', 'k-${facilityId}', 'Fake Dock');
insert into public.stops (id, stop_type, company_name) values ('${stopId}', 'delivery', 'Fake Dock');
insert into public.facility_reviews (id, facility_id, stop_id, author_id, company_id, stars, better_note)
  values ('${reviewId}', '${facilityId}', '${stopId}', '${userId}', '${companyId}', 3, '${text}');
insert into public.facility_notes (id, facility_id, author_id, company_id, body)
  values ('${noteId}', '${facilityId}', '${userId}', '${companyId}', '${text}');`);
}

await place(BOSS, 'boss@example.test', C_MEMBER, 'Fake Co', false, id(90), id(91), id(92), id(93), 'boss');
await db.exec(`insert into auth.users (id, email, last_sign_in_at) values ('${MEMBER}', 'member@example.test', '2026-10-01T00:00:00Z');
insert into public.company_members (profile_id, user_id, role) values ('${C_MEMBER}', '${MEMBER}', 'driver');
insert into public.facilities (id, key, name) values ('${id(21)}', 'k-member', 'Member Dock');
insert into public.stops (id, stop_type, company_name) values ('${id(22)}', 'pickup', 'Member Dock');
insert into public.facility_reviews (id, facility_id, stop_id, author_id, company_id, stars, better_note)
  values ('${id(23)}', '${id(21)}', '${id(22)}', '${MEMBER}', '${C_MEMBER}', 4, 'member kept');
insert into public.facility_notes (id, facility_id, author_id, company_id, body)
  values ('${id(24)}', '${id(21)}', '${MEMBER}', '${C_MEMBER}', 'member note');`);

await db.exec(`select public.account_deletion_apply('${MEMBER}')`);
const memberReview = (await db.query(`select author_id, company_id, stars, better_note from public.facility_reviews where id = '${id(23)}'`)).rows[0];
const memberNote = (await db.query(`select author_id, company_id, body from public.facility_notes where id = '${id(24)}'`)).rows[0];
ok(memberReview && memberReview.author_id == null && memberReview.company_id == null && memberReview.stars === 4 && memberReview.better_note === 'member kept', 'member delete keeps the review and clears author and company');
ok(memberNote && memberNote.author_id == null && memberNote.company_id == null && memberNote.body === 'member note', 'member delete keeps the note and clears author and company');

await place(LIVE, 'live@example.test', C_LIVE, 'Live Fake Co', false, id(31), id(32), id(33), id(34), 'owner kept');
await db.exec(`insert into public.account_deletion_requests (user_id, company_profile_id, kind, purge_after, baseline_sign_in_at)
  values ('${LIVE}', '${C_LIVE}', 'company', now() - interval '1 day', '2026-10-01T00:00:00Z')`);
await db.exec(`select public.account_deletion_apply('${LIVE}')`);
const ownerReview = (await db.query(`select author_id, company_id, better_note from public.facility_reviews where id = '${id(31)}'`)).rows[0];
ok(ownerReview && ownerReview.author_id == null && ownerReview.company_id == null && ownerReview.better_note === 'owner kept', 'owner purge keeps the review and clears author and company');
ok((await db.query(`select count(*)::int n from public.company_profiles where id = '${C_LIVE}'`)).rows[0].n === 0, 'owner purge removes that company');

await place(DEMO, 'demo@example.test', C_DEMO, 'Ordinary Name', true, id(41), id(42), id(43), id(44), 'demo kept');
await db.exec(`select public.account_deletion_apply('${DEMO}')`);
const demoReview = (await db.query(`select author_id, company_id, stars, better_note from public.facility_reviews where id = '${id(41)}'`)).rows[0];
ok(demoReview && demoReview.author_id == null && demoReview.company_id == null && demoReview.stars === 3 && demoReview.better_note === 'demo kept', 'demo purge keeps the review and clears author and company');
ok((await db.query(`select count(*)::int n from public.facility_reviews`)).rows[0].n === 4, 'nothing deletes facility review rows');
ok((await db.query(`select count(*)::int n from public.facility_reviews where author_id is not null or company_id is not null`)).rows[0].n === 1, 'only the untouched company still has a linked review');

if (!process.exitCode) console.log('all passed');
