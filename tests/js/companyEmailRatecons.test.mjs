// Emailed rate cons are company-wide for the office team (Marc, Oct 22). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { rateconCompanyFor } from '../../app/lib/rateconEmail.js';
import { createLoadRpc, createLoadFromDoc, teammateEmailDoc, EMAIL_CREATE_RPC } from '../../app/lib/rateconDrafts.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DISP = '00000000-0000-4000-8000-0000000000a5', DRIVER = '00000000-0000-4000-8000-0000000000a2', LONER = '00000000-0000-4000-8000-0000000000a9';
const P1 = '00000000-0000-4000-8000-0000000000f1';
const SQL = read('../../supabase/migrations/20261022150000_company_email_ratecons.sql');

test('inbound: company = the one the receiver owns, else where they are on the office team; drivers / no company → null', async () => {
  const sb = fakeSupabase({ tables: { company_profiles: [{ id: P1, owner_id: OWNER }],
    company_members: [{ profile_id: P1, user_id: DISP, role: 'dispatcher' }, { profile_id: P1, user_id: DRIVER, role: 'driver' }] } });
  assert.equal(await rateconCompanyFor(sb, OWNER), P1);
  assert.equal(await rateconCompanyFor(sb, DISP), P1, 'a dispatcher’s own ratecon+token address tags the company');
  assert.equal(await rateconCompanyFor(sb, DRIVER), null);
  assert.equal(await rateconCompanyFor(sb, LONER), null);
});

test('Create load: email docs use the company RPC (falls back before the migration); uploads keep the old one', async () => {
  assert.equal(createLoadRpc({ source: 'email' }), EMAIL_CREATE_RPC);
  assert.equal(createLoadRpc({ source: 'upload' }), 'create_load_from_document');
  const calls = [];
  const sb = (missing) => ({ rpc: async (fn, a) => { calls.push([fn, a]); return fn === EMAIL_CREATE_RPC && missing ? { data: null, error: { code: 'PGRST202' } } : { data: 'L1', error: null }; } });
  assert.deepEqual(await createLoadFromDoc(sb(false), { id: 'd1', source: 'email' }, 'America/Chicago'), { data: 'L1', error: null });
  assert.deepEqual(calls.pop(), [EMAIL_CREATE_RPC, { p_document: 'd1', p_tz: 'America/Chicago' }]);
  calls.length = 0;
  await createLoadFromDoc(sb(true), { id: 'd1', source: 'email' }, 'America/Chicago');
  assert.deepEqual(calls.map((c) => c[0]), [EMAIL_CREATE_RPC, 'create_load_from_document']);
  calls.length = 0;
  await createLoadFromDoc(sb(false), { id: 'd2', source: 'upload' }, 'X');
  assert.deepEqual(calls.map((c) => c[0]), ['create_load_from_document']);
});

test('teammate drafts: read + Create load, but delete / change type stay with the receiver', () => {
  assert.equal(teammateEmailDoc({ source: 'email', user_id: DISP }, OWNER), true);
  assert.equal(teammateEmailDoc({ source: 'email', user_id: OWNER }, OWNER), false);
  assert.equal(teammateEmailDoc({ source: 'upload', user_id: DISP }, OWNER), false);
  const page = read('../../app/documents/page.js');
  assert.match(page, /const DOC_COLS = 'id, user_id,/);
  assert.match(page, /\{!teammateEmailDoc\(d, user\?\.id\) && <ConfirmButton prompt=\{deletePrompt\(d\)\}/);
  assert.match(page, /canChangeType && !teammateEmailDoc\(d, user\?\.id\) &&/);
  assert.match(page, /await createLoadFromDoc\(supabase, doc,/);
});

test('migration: office roles only (no driver), company via inbound_emails.company_id, read-only policies', () => {
  assert.match(SQL, /create or replace function public\.email_doc_company\(p_inbound uuid, p_user uuid\)/);
  assert.match(SQL, /e\.company_id from public\.inbound_emails e where e\.id = p_inbound/);
  const roles = SQL.match(/in \('owner', 'management', 'dispatcher'\)/g) || [];
  assert.ok(roles.length >= 4); assert.ok(!/'driver'/.test(SQL));
  assert.match(SQL, /create policy documents_select_company_email on public\.documents for select to authenticated/);
  assert.match(SQL, /create policy documents_select_company_email on storage\.objects for select to authenticated/);
  assert.match(SQL, /company_id is not null and public\.company_role\(company_id\)/);
  assert.ok(!/create policy[^;]*for (insert|update|delete|all)/.test(SQL), 'no new write policies');
  assert.ok(!/^\s*(delete from|truncate)/im.test(SQL), 'no data changes');
});

test('migration: create_load_from_email_document → owner’s load, row lock, second tap returns the same load', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.create_load_from_email_document'));
  assert.match(fn, /security definer/);
  assert.match(fn, /where id = p_document\s+for update;/);
  assert.match(fn, /if v_doc\.load_id is not null then\s+return v_doc\.load_id;/);
  assert.match(fn, /select p\.owner_id into v_owner from public\.company_profiles p where p\.id = v_company;/);
  assert.match(fn, /insert into public\.loads \(user_id, status, broker_name, broker_load_number, rate, notes\)\s+values \(\s+v_owner,/);
  assert.match(fn, /v_doc\.source is distinct from 'email'/);
  assert.match(fn, /grant execute on function public\.create_load_from_email_document\(uuid, text\) to authenticated/);
  assert.ok(fn.indexOf('return v_doc.load_id') < fn.indexOf('insert into public.loads'));
});

test('follow-up migration: fallback through company_members for a member’s address with no company_id', () => {
  const f = read('../../supabase/migrations/20261022180000_email_doc_company_member_fallback.sql');
  assert.match(f, /create or replace function public\.email_doc_company\(p_inbound uuid, p_user uuid\)/);
  assert.match(f, /from public\.company_members m where m\.user_id = p_user/);
  assert.ok(f.indexOf('company_profiles p where p.owner_id = p_user') < f.indexOf('company_members m'), 'owner first, then membership');
  assert.ok(!/create policy|drop policy|update public\.|delete from|insert into/i.test(f), 'function change only');
});

test('client lists never filter by user_id = me (RLS decides; teammates’ email drafts show)', () => {
  const page = read('../../app/documents/page.js');
  const q = page.slice(page.indexOf('const q = (cols) =>'), page.indexOf('let { data, error } = await q('));
  assert.ok(!/user_id/.test(q));
  assert.ok(!/user_id/.test(read('../../app/components/EmailDraftsBanner.js')));
});
