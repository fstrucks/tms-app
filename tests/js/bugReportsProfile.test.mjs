import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { POST, GET } from '../../app/api/bug-reports/route.js';
import { listBugReports } from '../../app/lib/bugReportsAdmin.js';

// Fake data only.
const OA = '00000000-0000-4000-8000-0000000000a1', OB = '00000000-0000-4000-8000-0000000000b1';
const DUAL = '00000000-0000-4000-8000-0000000000d1', LATE = '00000000-0000-4000-8000-0000000000e1';
const PA = '00000000-0000-4000-8000-00000000aaa0', PB = '00000000-0000-4000-8000-00000000bbb0';
const profiles = [{ id: PA, owner_id: OA, legal_name: 'FAKE A' }, { id: PB, owner_id: OB, legal_name: 'FAKE B' }];
const members = [
  { profile_id: PA, user_id: OA, role: 'owner', created_at: '2026-10-01T00:00:00Z' },
  { profile_id: PB, user_id: OB, role: 'owner', created_at: '2026-10-01T00:00:00Z' },
  { profile_id: PA, user_id: DUAL, role: 'driver', created_at: '2026-10-02T00:00:00Z' },
  { profile_id: PB, user_id: DUAL, role: 'driver', created_at: '2026-10-05T00:00:00Z' }];
const good = { what_happened: 'Save did nothing' };
const req = (body, { cookie } = {}) => new Request('http://x/api/bug-reports', { method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json', authorization: 'Bearer fake', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const post = async (uid, body, { cookie, svc } = {}) => {
  const uc = fakeSupabase({ tables: { bug_reports: [] }, user: { id: uid, email: 'u@example.test' } });
  const sb = svc === undefined ? fakeSupabase({ tables: { company_profiles: profiles, company_members: members } }) : svc;
  const res = await POST(req(body, { cookie }), { deps: { mkUserClient: () => uc, sb } });
  return { res, row: uc.db.bug_reports[0] };
};

test('POST: profile_id comes from the server-side active company, never the body; status is new', async () => {
  const { res, row } = await post(DUAL, { ...good, profile_id: PA, status: 'fixed' });
  assert.equal(res.status, 200);
  assert.equal(row.profile_id, PB, 'default = most recently joined company, body value ignored');
  assert.equal(row.status, 'new');
  assert.equal((await post(DUAL, good, { cookie: `ph_active_company=${DUAL}.${PA}` })).row.profile_id, PA, 'active-company cookie choice');
  assert.equal((await post(DUAL, good, { cookie: `ph_active_company=${OA}.${PA}` })).row.profile_id, PB, 'another user’s cookie is ignored');
  assert.equal((await post(OA, good)).row.profile_id, PA, 'owner → owned company');
  assert.equal((await post(LATE, { ...good, profile_id: PA })).row.profile_id, null, 'no company → null, body ignored');
  const noSvc = await post(DUAL, good, { svc: null });
  assert.equal(noSvc.res.status, 200); assert.equal(noSvc.row.profile_id, null, 'lookup unavailable → still saved, shows to no owner');
});

test('POST: falls back without profile_id when only the first migration is applied', async () => {
  const uc = fakeSupabase({ tables: { bug_reports: [] }, user: { id: OA, email: 'u@example.test' } });
  let n = 0; const real = uc.from.bind(uc);
  uc.from = (t) => { const q = real(t); const ins = q.insert.bind(q);
    q.insert = (row) => { n++; if ('profile_id' in row) return { select: () => ({ single: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'profile_id' column of 'bug_reports'" } }) }) }; return ins(row); };
    return q; };
  const res = await POST(req(good), { deps: { mkUserClient: () => uc, sb: fakeSupabase({ tables: { company_profiles: profiles, company_members: members } }) } });
  assert.equal(res.status, 200); assert.equal(n, 2); assert.equal(uc.db.bug_reports[0].status, 'new');
});

test('admin list: filtered by profile_id only (two-company user, later joiner, null rows)', async () => {
  const rows = [
    { id: 'dualA', user_id: DUAL, profile_id: PA, created_at: '2026-10-10T00:00:00Z' },
    { id: 'dualB', user_id: DUAL, profile_id: PB, created_at: '2026-10-11T00:00:00Z' },
    { id: 'lateOld', user_id: LATE, profile_id: PB, created_at: '2026-10-03T00:00:00Z' },
    { id: 'legacy', user_id: DUAL, profile_id: null, created_at: '2026-10-01T00:00:00Z' }];
  // LATE joins company A afterwards.
  const svc = fakeSupabase({ tables: { bug_reports: rows, company_members: [...members, { profile_id: PA, user_id: LATE, role: 'driver' }] } });
  assert.deepEqual((await listBugReports(svc, { id: PA, owner_id: OA })).reports.map((r) => r.id), ['dualA']);
  assert.deepEqual((await listBugReports(svc, { id: PB, owner_id: OB })).reports.map((r) => r.id), ['dualB', 'lateOld']);
  assert.deepEqual((await listBugReports(svc, {})).reports, []);
  const src = readFileSync('app/lib/bugReportsAdmin.js', 'utf8');
  assert.match(src, /\.eq\('profile_id', profile\.id\)/); assert.doesNotMatch(src, /\.in\('user_id'/);
});

test('migration 20261028000300: additive, idempotent, tightened insert policy', () => {
  const s = readFileSync('supabase/migrations/20261028000300_bug_reports_profile.sql', 'utf8');
  assert.match(s, /add column if not exists profile_id uuid null references public\.company_profiles\(id\) on delete set null/);
  assert.match(s, /drop policy if exists "bug_reports_insert_own"/);
  assert.match(s, /auth\.uid\(\) = user_id\s+and status = 'new'/);
  assert.doesNotMatch(s, /grant update|grant delete/i);
});
