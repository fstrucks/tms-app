import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { GET } from '../../app/api/bug-reports/route.js';
import { deviceLabel, ownScreenshot, SIGNED_URL_TTL } from '../../app/lib/bugReportsAdmin.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa', T1 = '00000000-0000-4000-8000-0000000000t1', T2 = '00000000-0000-4000-8000-0000000000t2';
const OTHER = '00000000-0000-4000-8000-00000000cccc', STRANGER = '00000000-0000-4000-8000-00000000dddd';
const P1 = 'p-marc', P2 = 'p-other';
const rep = (id, user_id, at, extra = {}) => ({ id, user_id, user_email: `${id}@example.test`, what_happened: `bug ${id}`, expected: null, page_url: 'http://localhost/loads', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', viewport: '393x852 @3x', screenshot_path: null, status: 'new', created_at: at, ...extra });
const tables = () => ({
  company_profiles: [{ id: P1, owner_id: OWNER }, { id: P2, owner_id: OTHER }],
  company_members: [{ profile_id: P1, user_id: OWNER, role: 'owner' }, { profile_id: P1, user_id: T1, role: 'driver' }, { profile_id: P1, user_id: T2, role: 'dispatcher' }, { profile_id: P2, user_id: OTHER, role: 'owner' }],
  bug_reports: [
    rep('old', T1, '2026-10-17T10:00:00Z', { screenshot_path: `${T1}/bug-reports/1-a.png` }),
    rep('mine', OWNER, '2026-10-17T12:00:00Z'),
    rep('new', T2, '2026-10-18T01:00:00Z', { status: 'seen' }),
    rep('forged', T2, '2026-10-17T11:00:00Z', { screenshot_path: `${T1}/bug-reports/1-a.png` }),
    rep('other', OTHER, '2026-10-18T02:00:00Z', { screenshot_path: `${OTHER}/bug-reports/x.png` }),
    rep('stranger', STRANGER, '2026-10-18T03:00:00Z')],
});
// One shared DB. The user client only sees the caller's own company_profiles row (like RLS); the service client sees all.
function setup({ caller, missing = [], noService = false } = {}) {
  const svcDb = fakeSupabase({ tables: tables(), missing });
  const signed = [];
  const svc = { ...svcDb, storage: { from: (b) => ({ createSignedUrl: async (p, ttl) => { signed.push({ b, p, ttl }); return { data: { signedUrl: `https://signed.example/${p}?ttl=${ttl}` }, error: null }; } }) } };
  const own = fakeSupabase({ tables: { company_profiles: tables().company_profiles.filter((p) => p.owner_id === caller) }, user: { id: caller, email: 'x@example.test' } });
  const uc = { ...own, storage: { from: () => ({ createSignedUrl: async () => { signed.push({ user: true }); return {}; } }) } };
  return { signed, deps: { mkUserClient: () => uc, sb: noService ? null : svc, mkService: () => null } };
}
const req = (token = 'fake') => new Request('http://x/api/bug-reports', { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('owner list: owner sees own + their testers’ reports only, newest first', async () => {
  const { deps } = setup({ caller: OWNER });
  const res = await GET(req(), { deps }); assert.equal(res.status, 200);
  const { reports } = await res.json();
  assert.deepEqual(reports.map((r) => r.id), ['new', 'mine', 'forged', 'old']);
  const r = reports[0];
  for (const k of ['user_email', 'page_url', 'user_agent', 'viewport', 'what_happened', 'expected', 'status', 'created_at']) assert.ok(k in r, k);
  assert.equal(r.status, 'seen'); assert.equal('user_id' in r, false); assert.equal('screenshot_path' in r, false, 'no raw storage path to the browser');
});

test('owner list: non-owners (tester, other owner’s view, stranger) are refused or scoped', async () => {
  for (const caller of [T1, T2, STRANGER]) {
    const { deps, signed } = setup({ caller });
    const res = await GET(req(), { deps });
    assert.equal(res.status, 404, caller); assert.equal((await res.json()).reports, undefined); assert.equal(signed.length, 0);
  }
  const { deps } = setup({ caller: OTHER });
  const { reports } = await (await GET(req(), { deps })).json();
  assert.deepEqual(reports.map((r) => r.id), ['other'], 'another owner sees only their own company');
  assert.equal((await GET(req(null), setup({ caller: OWNER }))).status, 401);
});

test('owner list: signed screenshot URLs, short-lived, service-side, only for the reporter’s own folder', async () => {
  const { deps, signed } = setup({ caller: OWNER });
  const { reports } = await (await GET(req(), { deps })).json();
  const byId = Object.fromEntries(reports.map((r) => [r.id, r]));
  assert.equal(byId.old.screenshot_url, `https://signed.example/${T1}/bug-reports/1-a.png?ttl=${SIGNED_URL_TTL}`);
  assert.equal(byId.forged.screenshot_url, null, 'path outside the reporter’s folder is never signed');
  assert.equal(byId.mine.screenshot_url, null);
  assert.deepEqual(signed, [{ b: 'documents', p: `${T1}/bug-reports/1-a.png`, ttl: 600 }]);
  assert.ok(SIGNED_URL_TTL <= 900);
  assert.equal(ownScreenshot({ user_id: 'u', screenshot_path: 'u/bug-reports/../x' }), false);
});

test('owner list: missing table → 200 setupNeeded (graceful); no service key → 503', async () => {
  const res = await GET(req(), setup({ caller: OWNER, missing: ['bug_reports'] }));
  assert.equal(res.status, 200); const j = await res.json();
  assert.equal(j.setupNeeded, true); assert.deepEqual(j.reports, []); assert.match(j.error, /switched on yet/);
  assert.equal((await GET(req(), setup({ caller: T1, missing: ['bug_reports'] }))).status, 404, 'still 404 for non-owners');
  assert.equal((await GET(req(), setup({ caller: OWNER, noService: true }))).status, 503);
});

test('owner list: page, menu item and shared-file edits', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Mobile Safari/604.1'), 'iPhone · Safari');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile Safari/537.36'), 'Android · Chrome');
  const page = readFileSync('app/bug-reports/page.js', 'utf8');
  assert.match(page, /res\.status === 404/); assert.match(page, /Page not found/); assert.match(page, /bug-reports-setup/);
  const menu = readFileSync('app/components/ui/AccountMenu.js', 'utf8');
  assert.match(menu, /import BugReportsMenuItem from '..\/BugReportsMenuItem'/);
  assert.match(menu, /<BugReportsMenuItem owner=\{owner\} onPick=\{\(\) => setOpen\(false\)\} \/>/); // shared owner check (QA #78 b)
  assert.match(menu, /querySelectorAll\('\[role=menuitem\](,\[role=menuitemradio\])?'\)/); // dark mode adds the Theme radios
  const item = readFileSync('app/components/BugReportsMenuItem.js', 'utf8');
  assert.match(readFileSync('app/lib/accountOwner.js', 'utf8'), /from\('company_profiles'\)\.select\('id'\)\.eq\('owner_id', userId\)/); assert.match(item, /if \(!owner\) return null/);
  assert.doesNotMatch(readFileSync('supabase/migrations/20261018000100_bug_reports.sql', 'utf8'), /owner|security definer/i, 'no migration change needed');
});
