// 20261028000200_facility_reviews_keep_on_user_delete.sql against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: MIG_DIR=<repo>/supabase/migrations/ node tests/sql/facility_reviews_keep_on_user_delete.pglite.mjs  (fake data only)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated; create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null);
create table public.stops (id uuid primary key default gen_random_uuid(), load_id uuid references public.loads(id) on delete cascade, stop_type text,
  sequence int, company_name text, address_line1 text, city text, state text, zip text, appointment_start timestamptz, timezone text,
  arrived_at timestamptz, completed_at timestamptz, completion text);
create function public.us_state_tz(text) returns text language sql immutable as $$ select 'America/Chicago' $$;`);
for (const f of ['20261022190000_facility_reviews.sql', '20261022210000_facility_link_stop.sql', '20261022230000_facility_keep_and_autolink.sql',
  '20261022240000_facility_page_v2.sql', '20261024000100_facility_review_stars_nullable.sql', '20261024000200_facility_review_stars_summary.sql',
  '20261024000300_facility_review_visit_kind.sql']) await db.exec(readFileSync(R + f, 'utf8'));

const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
const F = '33333333-3333-3333-3333-333333333333';
const seed = async () => {
  await db.exec(`delete from public.facility_review_reports; delete from public.facility_note_reports; delete from public.facility_reviews;
    delete from public.facility_notes; delete from public.stops; delete from public.loads; delete from auth.users;
    insert into auth.users values ('${A}','a@example.com'),('${B}','b@example.com');
    insert into public.facilities (id, key, name, city, state) values ('${F}','fake-receiver-faketown-tx','FAKE Receiver','Faketown','TX') on conflict do nothing;
    insert into public.loads (id, user_id) values ('44444444-4444-4444-4444-444444444444','${A}');
    insert into public.stops (id, load_id, stop_type, company_name, city, state) values ('55555555-5555-5555-5555-555555555555','44444444-4444-4444-4444-444444444444','delivery','FAKE Receiver','Faketown','TX');
    insert into public.facility_reviews (id, facility_id, stop_id, author_id, stars, better_note) values
      ('66666666-6666-6666-6666-666666666666','${F}','55555555-5555-5555-5555-555555555555','${A}',3,'fake note');
    insert into public.facility_notes (facility_id, author_id, body) values ('${F}','${A}','fake gate code note');
    insert into public.facility_review_reports (review_id, reporter_id) values ('66666666-6666-6666-6666-666666666666','${B}');`);
};
const n = async (sql) => (await db.query(sql)).rows[0].n;

// Before: deleting the author deletes the review (the bug).
await seed();
await db.exec(`delete from auth.users where id='${A}'`);
ok(await n(`select count(*)::int n from public.facility_reviews`) === 0, 'before: deleting a user cascades and drops the review');

const mig = readFileSync(R + '20261028000200_facility_reviews_keep_on_user_delete.sql', 'utf8');
await db.exec(mig); await db.exec(mig);
ok(true, 'migration applies twice (idempotent)');
const cols = (await db.query(`select table_name t, column_name c, is_nullable from information_schema.columns
  where (table_name in ('facility_reviews','facility_notes') and column_name='author_id') or (table_name in ('facility_review_reports','facility_note_reports') and column_name='reporter_id')`)).rows;
ok(cols.length === 4 && cols.every((r) => r.is_nullable === 'YES'), 'author_id / reporter_id are nullable on all four tables');
const fks = (await db.query(`select conrelid::regclass::text t, conname, confdeltype from pg_constraint
  where contype='f' and confrelid='auth.users'::regclass and conrelid::regclass::text in ('facility_reviews','facility_notes','facility_review_reports','facility_note_reports')`)).rows;
ok(fks.length === 4 && fks.every((r) => r.confdeltype === 'n'), 'exactly one FK per table to auth.users, ON DELETE SET NULL');

await seed();
await db.exec(`delete from auth.users where id='${A}'`);
ok(await n(`select count(*)::int n from public.facility_reviews where author_id is null and stars = 3`) === 1, 'after: review kept with author_id null');
ok(await n(`select count(*)::int n from public.facility_notes where author_id is null`) === 1, 'after: note kept with author_id null');
const pub = (await db.query(`select * from public.facility_public_reviews('${F}', 50)`)).rows;
ok(pub.length === 1 && !('author_id' in pub[0]) && !('company_id' in pub[0]), 'public reviews still show the kept review, with no author or company');
const pubN = (await db.query(`select * from public.facility_public_notes('${F}', 50)`)).rows;
ok(pubN.length === 1 && Object.keys(pubN[0]).sort().join() === 'body,created_at,id', 'public notes return only id, body, created_at');
ok((await db.query(`select * from public.facility_summaries(array['${F}'::uuid])`)).rows[0].review_count === 1, 'summary still counts the kept review');
await db.exec(`delete from auth.users where id='${B}'`);
ok(await n(`select count(*)::int n from public.facility_review_reports where reporter_id is null`) === 1, 'a deleted reporter keeps the report, reporter null');
await db.exec(`insert into auth.users values ('${A}','a@example.com')`);
ok(await n(`select count(*)::int n from public.facility_reviews where author_id = '${A}'`) === 0, 'a re-created user id never owns the orphaned review');
await db.exec(`insert into public.facility_reviews (facility_id, stop_id, author_id, stars) values ('${F}','55555555-5555-5555-5555-555555555555','${A}',2)`);
ok(await n(`select count(*)::int n from public.facility_reviews where stop_id='55555555-5555-5555-5555-555555555555'`) === 2, 'a null-author review does not block a new review on the same stop');
let denied = false; try { await db.exec(`set role authenticated; select author_id from public.facility_reviews;`); } catch { denied = true; } finally { await db.exec('reset role'); }
ok(denied, 'signed-in users still cannot read facility_reviews directly');
if (!process.exitCode) console.log('all passed');
