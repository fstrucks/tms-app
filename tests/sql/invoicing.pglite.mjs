// Migration 20261021000100 (invoicing) against an in-memory Postgres (PGlite, WASM). LOCAL ONLY: never touches Supabase.
// Run: npm i --no-save @electric-sql/pglite && node tests/sql/invoicing.pglite.mjs
// Fake data only.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const R = process.env.MIG_DIR || new URL('../../supabase/migrations/', import.meta.url).pathname;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
create table public.loads (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text, broker_name text, broker_load_number text, rate numeric);
alter table public.loads enable row level security;
create policy loads_own on public.loads for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, update on public.loads to authenticated;
grant usage on schema public to authenticated, anon;
`);
await db.exec(readFileSync(R + '20261015001200_company_profiles.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on public.company_profiles, public.company_members to authenticated;`);
const O = '00000000-0000-0000-0000-00000000000a', D = '00000000-0000-0000-0000-00000000000d', P = '00000000-0000-0000-0000-00000000000b',
  M = '00000000-0000-0000-0000-00000000000c', O2 = '00000000-0000-0000-0000-0000000000a2';
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222';
const L1 = '33333333-3333-3333-3333-333333333331', L2 = '33333333-3333-3333-3333-333333333332', LX = '33333333-3333-3333-3333-333333333339';
await db.exec(`insert into auth.users values ('${O}','owner@example.com'),('${D}','driver@example.com'),('${P}','dispatch@example.com'),('${M}','mgmt@example.com'),('${O2}','owner2@example.com');
insert into public.company_profiles (id, owner_id, legal_name) values ('${C1}','${O}','FAKE Trucking LLC'),('${C2}','${O2}','OTHER FAKE Co');
insert into public.company_members values ('${C1}','${D}','driver'),('${C1}','${P}','dispatcher'),('${C1}','${M}','management');
insert into public.loads (id, user_id, status, broker_load_number, rate) values ('${L1}','${O}','delivered','TEST-1001',2400),('${L2}','${O}','delivered','TEST-4701',1950),('${LX}','${O2}','delivered','OTHER-1',900);`);
const MIG = readFileSync(R + '20261021000100_invoicing.sql', 'utf8');
await db.exec(MIG);
await db.exec(MIG); // idempotent

const as = async (uid, sql) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false); set role authenticated;`); try { return (await db.query(sql)).rows; } finally { await db.exec('reset role'); } };
const err = async (uid, sql) => { try { await as(uid, sql); return null; } catch (e) { return e.message; } };
const LINES = `'[{"type":"linehaul","label":"Linehaul","amount":2400}]'::jsonb`;

const cp = (await db.query(`select invoice_prefix, invoice_next_number, default_terms_days from public.company_profiles where id='${C1}'`)).rows[0];
ok(cp.invoice_prefix === 'INV-' && cp.invoice_next_number === 1001 && cp.default_terms_days === 30, 'defaults: INV-, 1001, Net 30');

// brokers / factors RLS
ok((await err(M, `insert into public.brokers (owner_id, name, billing_emails) values ('${O}', 'Acme Freight Brokerage (fake)', '{ap@example.com}')`)) === null, 'management adds a broker');
ok((await err(P, `insert into public.brokers (owner_id, name) values ('${O}', 'Dispatcher Broker')`)) !== null, 'dispatcher cannot add a broker');
ok((await as(P, `select name from public.brokers`)).length === 1, 'dispatcher can read brokers');
ok((await as(D, `select name from public.brokers`)).length === 0, 'driver sees no brokers');
ok((await as(O2, `select name from public.brokers`)).length === 0, 'other company sees no brokers');
ok((await err(O, `insert into public.brokers (owner_id, name) values ('${O}', ' acme freight brokerage (FAKE) ')`)) !== null, 'broker names are unique per company (case/space-insensitive)');
ok((await err(O, `insert into public.factors (owner_id, name, remit_to) values ('${O}', 'Sample Factor Co', 'Sample Factor Co, PO Box 0000, Example City')`)) === null, 'owner adds a factor');
const F = (await db.query(`select id from public.factors`)).rows[0].id;
const B = (await db.query(`select id from public.brokers`)).rows[0].id;

// billing settings on company_profiles
ok((await err(P, `update public.company_profiles set default_factor_id='${F}' where id='${C1}'`))?.includes('billing_not_allowed'), 'dispatcher cannot change billing settings');
ok((await err(P, `update public.company_profiles set phone='555-0100' where id='${C1}'`)) === null, 'dispatcher can still edit the rest of the profile');
ok((await err(M, `update public.company_profiles set default_factor_id='${F}', remit_to='FAKE Trucking LLC, 1 Test St' where id='${C1}'`)) === null, 'management sets the default factor');
await as(O, `update public.company_profiles set invoice_next_number=5 where id='${C1}'`);
ok((await db.query(`select invoice_next_number n from public.company_profiles where id='${C1}'`)).rows[0].n === 1001, 'the counter cannot be changed directly');
const F2 = (await as(O2, `insert into public.factors (owner_id, name) values ('${O2}', 'Other Factor') returning id`))[0].id;
ok((await err(O, `update public.company_profiles set default_factor_id='${F2}' where id='${C1}'`))?.includes('factor_not_in_company'), 'cannot pick another company’s factor');

// invoices
ok((await err(P, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L1}', ${LINES}, 2400)`)) !== null, 'dispatcher cannot create invoices');
ok((await err(D, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L1}', ${LINES}, 2400)`)) !== null, 'driver cannot create invoices');
ok((await err(M, `insert into public.invoices (owner_id, load_id, invoice_number, line_items, total) values ('${O}', '${L1}', 'INV-9', ${LINES}, 2400)`))?.includes('invoice_number_reserved'), 'numbers cannot be typed in');
ok((await err(M, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${LX}', ${LINES}, 900)`))?.includes('load_not_in_company'), 'cannot invoice another company’s load');
const I1 = (await as(M, `insert into public.invoices (owner_id, load_id, broker_id, line_items, total) values ('${O}', '${L1}', '${B}', ${LINES}, 2400) returning id`))[0].id;
ok(!!I1, 'management creates a draft');
ok((await err(M, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L1}', ${LINES}, 2400)`)) !== null, 'one active invoice per load');
ok((await as(P, `select id from public.invoices`)).length === 1, 'dispatcher can read invoices');
ok((await as(D, `select id from public.invoices`)).length === 0, 'driver cannot see invoices');
ok((await as(O2, `select id from public.invoices`)).length === 0, 'other company cannot see invoices');
ok((await err(P, `select public.finalize_invoice('${I1}')`))?.includes('not_allowed'), 'dispatcher cannot finalize');

const f1 = (await as(M, `select * from public.finalize_invoice('${I1}', '2026-10-21')`))[0];
ok(f1.invoice_number === 'INV-1001' && f1.status === 'ready' && new Date(f1.due_date).toISOString().startsWith('2026-11-20'), 'finalize: INV-1001, ready, due Net 30');
ok((await db.query(`select status from public.loads where id='${L1}'`)).rows[0].status === 'invoiced', 'finalize moves the load to invoiced');
ok((await err(M, `select public.finalize_invoice('${I1}')`))?.includes('not_draft'), 'cannot finalize twice');
ok((await err(O, `update public.invoices set invoice_number='INV-1' where id='${I1}'`))?.includes('invoice_number_locked'), 'number is locked');
ok((await err(O, `update public.invoices set total=1 where id='${I1}'`))?.includes('invoice_locked'), 'amounts locked after finalize');
ok((await err(O, `update public.invoices set status='sent', sent_to='ap@example.com' where id='${I1}'`)) === null, 'status can move to sent');
ok((await err(O, `delete from public.invoices where id='${I1}'`)) === null && (await db.query(`select id from public.invoices where id='${I1}'`)).rows.length === 1, 'numbered invoices cannot be deleted');

const I2 = (await as(O, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L2}', ${LINES}, 1950) returning id`))[0].id;
ok((await as(O, `select invoice_number from public.finalize_invoice('${I2}')`))[0].invoice_number === 'INV-1002', 'next number is INV-1002');
const I3 = (await as(O, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', null, '[]', 0) returning id`))[0].id;
ok((await err(O, `select public.finalize_invoice('${I3}')`))?.includes('no_lines'), 'empty invoice cannot be finalized');
ok((await err(O, `delete from public.invoices where id='${I3}'`)) === null && (await db.query(`select id from public.invoices where id='${I3}'`)).rows.length === 0, 'drafts can be deleted');

// void + re-draft
await as(O, `update public.invoices set status='void', void_reason='test' where id='${I2}'`);
ok((await err(O, `update public.invoices set status='ready' where id='${I2}'`))?.includes('invoice_void'), 'void stays void');
ok((await err(O, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L2}', ${LINES}, 1950)`)) === null, 'a voided load can get a new draft');

// events
ok((await err(M, `insert into public.invoice_events (invoice_id, owner_id, kind, created_by) values ('${I1}', '${O}', 'marked_sent', '${M}')`)) === null, 'management logs an event');
ok((await err(M, `insert into public.invoice_events (invoice_id, owner_id, kind, created_by) values ('${I1}', '${O}', 'marked_sent', '${O}')`)) !== null, 'cannot log as someone else');
ok((await err(P, `insert into public.invoice_events (invoice_id, owner_id, kind, created_by) values ('${I1}', '${O}', 'download', '${P}')`)) !== null, 'dispatcher cannot log events');
ok((await err(O, `update public.invoice_events set note='x'`)) !== null || (await db.query(`select count(*)::int n from public.invoice_events where note='x'`)).rows[0].n === 0, 'events cannot be edited');
const cb = (await db.query(`select created_by from public.invoices where id='${I1}'`)).rows[0].created_by;
ok(cb === M, 'created_by defaults to the caller');
ok((await err(M, `insert into public.invoices (owner_id, load_id, line_items, total, created_by) values ('${O}', null, '[]', 0, '${O}')`)) !== null, 'cannot insert an invoice as someone else');
ok((await err(M, `insert into public.invoices (owner_id, load_id, line_items, total, created_by) values ('${O}', null, '[]', 0, null)`)) !== null, 'cannot insert with created_by null');
console.log(process.exitCode ? 'FAILED' : 'all ok');

// ---- 20261021000200: auto-draft on delivered ----
await db.exec(readFileSync(R + '20261021000200_invoice_autodraft.sql', 'utf8'));
await db.exec(readFileSync(R + '20261021000200_invoice_autodraft.sql', 'utf8')); // idempotent
const L3 = '33333333-3333-3333-3333-333333333333', L4 = '33333333-3333-3333-3333-333333333334';
await db.exec(`insert into public.loads (id, user_id, status, broker_load_number, broker_name, rate) values ('${L3}','${O}','in_transit','TEST-2001','Acme Freight Brokerage (fake)',1800.5),('${L4}','${O}','in_transit','TEST-2002',null,null);
update public.loads set broker_id='${B}' where id='${L3}';`);
await as(O, `update public.loads set status='delivered' where id='${L3}'`);
const ad = (await db.query(`select * from public.invoices where load_id='${L3}'`)).rows;
ok(ad.length === 1 && ad[0].status === 'draft' && ad[0].auto_drafted && Number(ad[0].total) === 1800.5 && ad[0].line_items[0].type === 'linehaul', 'delivered → draft with the linehaul');
ok(ad[0].factored === true && ad[0].factor_id === F && ad[0].broker_id === B && ad[0].bill_to.emails[0] === 'ap@example.com', 'draft follows the company default factor and the broker record');
await as(O, `update public.loads set status='invoiced' where id='${L3}'`); await as(O, `update public.loads set status='delivered' where id='${L3}'`);
ok((await db.query(`select count(*)::int n from public.invoices where load_id='${L3}'`)).rows[0].n === 1, 'no second draft when delivered again');
await as(O, `update public.loads set status='delivered' where id='${L4}'`);
const ad4 = (await db.query(`select total, line_items from public.invoices where load_id='${L4}'`)).rows[0];
ok(ad4 && Number(ad4.total) === 0 && ad4.line_items.length === 0, 'no rate → empty draft (cannot be finalized until a charge is added)');
ok((await db.query(`select status from public.loads where id='${L4}'`)).rows[0].status === 'delivered', 'status change still saved');
// The trigger is SECURITY DEFINER, so its insert isn't held to the insert policy: it works when the server's service
// role (no signed-in user, created_by null) or a member who can't create invoices sets the status.
const L5 = '33333333-3333-3333-3333-333333333335', L6 = '33333333-3333-3333-3333-333333333336';
await db.exec(`insert into public.loads (id, user_id, status, broker_load_number, rate) values ('${L5}','${O}','in_transit','TEST-2003',500),('${L6}','${O}','in_transit','TEST-2004',600);
grant update on public.loads to authenticated; create policy loads_member_test on public.loads for all to authenticated using (true) with check (true);`);
await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); update public.loads set status='delivered' where id='${L5}';`);
const s5 = (await db.query(`select created_by from public.invoices where load_id='${L5}'`)).rows;
ok(s5.length === 1 && s5[0].created_by === null, 'service-role status change still auto-drafts (created_by null)');
await as(D, `update public.loads set status='delivered' where id='${L6}'`);
const s6 = (await db.query(`select created_by from public.invoices where load_id='${L6}'`)).rows;
ok(s6.length === 1 && s6[0].created_by === D, 'a driver marking delivered still auto-drafts (insert policy not applied inside the trigger)');
// Void a short-paid invoice and a draft, and delete a draft, with the existing rules (no SQL change needed).
const L7 = '33333333-3333-3333-3333-333333333337';
await db.exec(`insert into public.loads (id, user_id, status, broker_load_number, rate) values ('${L7}','${O}','delivered','TEST-2005',700)`);
const I7 = (await as(M, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L7}', ${LINES}, 700) returning id`))[0].id;
await as(M, `select public.finalize_invoice('${I7}')`);
ok((await err(M, `update public.invoices set status='short_paid', paid_amount=600, paid_at='2026-10-21' where id='${I7}'`)) === null
  && (await err(M, `update public.invoices set status='void', void_reason='test data' where id='${I7}'`)) === null, 'management voids a short-paid invoice');
const DV = (await as(M, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L7}', '[]', 0) returning id`))[0].id;
ok((await err(M, `update public.invoices set status='void', void_reason='test data' where id='${DV}'`)) === null, 'management voids a draft (no number)');
const DD = (await as(M, `insert into public.invoices (owner_id, load_id, line_items, total) values ('${O}', '${L7}', '[]', 0) returning id`))[0].id;
await as(M, `delete from public.invoices where id='${DD}'`);
ok((await db.query(`select id from public.invoices where id='${DD}'`)).rows.length === 0, 'management deletes a draft');
ok((await err(P, `update public.invoices set status='void' where id='${DV}'`)) === null && (await db.query(`select status from public.invoices where id='${DV}'`)).rows[0].status === 'void', 'dispatcher update is a no-op (RLS)');
console.log(process.exitCode ? 'FAILED' : 'all ok (autodraft)');
