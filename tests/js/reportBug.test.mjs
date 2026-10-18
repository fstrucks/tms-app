import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { POST } from '../../app/api/bug-reports/route.js';
import { watchCovered, COVER_ATTR, buildBugRow, captureContext, checkScreenshot, screenshotPath, isBugButtonHidden, BUG_MIGRATION, SCREENSHOT_MAX_BYTES } from '../../app/lib/bugReport.js';

const U = { id: '00000000-0000-4000-8000-00000000aaaa', email: 'tester@example.test' };
const req = (body, token = 'fake') => new Request('http://x/api/bug-reports', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const ctx = (opts = {}) => { const f = fakeSupabase({ tables: { bug_reports: [] }, user: U, ...opts }); return { f, deps: { mkUserClient: () => f } }; };
const good = { what_happened: '  Save did nothing  ', expected: 'It saves', page_url: 'http://localhost/loads/1', user_agent: 'Mozilla/5.0 (iPhone)', viewport: '393x852 @3x' };

test('bug report: saves own row with email + user_id from the token, not the body', async () => {
  const { f, deps } = ctx();
  const res = await POST(req({ ...good, user_id: 'someone-else', user_email: 'spoof@example.test' }), { deps });
  assert.equal(res.status, 200); const j = await res.json(); assert.equal(j.ok, true); assert.ok(j.id);
  const [row] = f.db.bug_reports;
  assert.equal(row.user_id, U.id); assert.equal(row.user_email, 'tester@example.test');
  assert.equal(row.what_happened, 'Save did nothing'); assert.equal(row.expected, 'It saves');
  assert.equal(row.page_url, good.page_url); assert.equal(row.user_agent, good.user_agent); assert.equal(row.viewport, '393x852 @3x');
  assert.equal(row.screenshot_path, null);
});

test('bug report: auth required; validation; screenshot path must be the caller’s bug-reports folder', async () => {
  assert.equal((await POST(req(good, null), ctx())).status, 401);
  const r = await POST(req({ what_happened: '   ' }), ctx()); assert.equal(r.status, 400); assert.match((await r.json()).error, /what happened/i);
  assert.equal((await POST(req({ what_happened: 'x'.repeat(4001) }), ctx())).status, 400);
  for (const p of ['00000000-0000-4000-8000-00000000bbbb/bug-reports/a.png', `${U.id}/rate-cons/a.png`, `${U.id}/bug-reports/../x.png`])
    assert.equal((await POST(req({ ...good, screenshot_path: p }), ctx())).status, 400, p);
  const { f, deps } = ctx(); const ok = `${U.id}/bug-reports/1-abc.png`;
  assert.equal((await POST(req({ ...good, screenshot_path: ok }), { deps })).status, 200);
  assert.equal(f.db.bug_reports[0].screenshot_path, ok);
});

test('bug report: table missing (migration unapplied) → 503 setupNeeded, friendly message', async () => {
  const res = await POST(req(good), ctx({ missing: ['bug_reports'] }));
  assert.equal(res.status, 503); const j = await res.json();
  assert.equal(j.setupNeeded, true); assert.match(j.error, /switched on yet/);
});

test('bug report: helpers capture page/device and check screenshots like the documents bucket', () => {
  const c = captureContext({ location: { href: 'https://app/x?y=1' }, navigator: { userAgent: 'UA' }, innerWidth: 393, innerHeight: 852, devicePixelRatio: 3 });
  assert.deepEqual(c, { page_url: 'https://app/x?y=1', user_agent: 'UA', viewport: '393x852 @3x' });
  assert.equal(captureContext({ location: { href: 'a' }, navigator: { userAgent: 'b' }, innerWidth: 1280, innerHeight: 900, devicePixelRatio: 1 }).viewport, '1280x900');
  assert.equal(checkScreenshot({ type: 'image/png', size: 1000 }), null);
  assert.match(checkScreenshot({ type: 'application/pdf', size: 1 }), /JPG/);
  assert.match(checkScreenshot({ type: 'image/png', size: SCREENSHOT_MAX_BYTES + 1 }), /10 MB/);
  assert.match(screenshotPath(U.id, { type: 'image/jpeg' }, 5), new RegExp(`^${U.id}/bug-reports/5-[a-z0-9]+\\.jpg$`));
  assert.equal(buildBugRow({ what_happened: 'x' }, U).row.expected, null);
  for (const p of ['/login', '/auth/callback', '/forgot-password']) assert.equal(isBugButtonHidden(p), true);
  assert.equal(isBugButtonHidden('/loads/1'), false);
});

test('bug report migration: own-row RLS insert/select only, no update/delete, screenshots stay in documents bucket', () => {
  const sql = readFileSync(`supabase/migrations/${BUG_MIGRATION}`, 'utf8');
  assert.match(sql, /create table if not exists public\.bug_reports/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for insert to authenticated\s+with check \(auth\.uid\(\) = user_id\)/);
  assert.match(sql, /for select to authenticated\s+using \(auth\.uid\(\) = user_id\)/);
  assert.match(sql, /grant select, insert on public\.bug_reports to authenticated/);
  assert.doesNotMatch(sql, /for (update|delete)|grant[^;]*(update|delete)/i);
  assert.doesNotMatch(sql, /storage\.(buckets|objects)/i, 'no storage SQL: existing documents policies allow <uid>/bug-reports/');
  assert.match(sql, /screenshot_path like \(user_id::text \|\| '\/bug-reports\/%'\)/);
  const bucket = readFileSync('supabase/migrations/20261010000000_documents_bucket.sql', 'utf8');
  assert.match(bucket, /documents_insert_own[\s\S]*\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
});

test('bug report: layout change is one import + one mount line; button hides on sign-in pages', () => {
  const layout = readFileSync('app/layout.js', 'utf8');
  assert.match(layout, /import ReportBugButton from '.\/components\/ReportBugButton'/);
  assert.match(layout, /<ReportBugButton \/>/);
  const comp = readFileSync('app/components/ReportBugButton.js', 'utf8');
  assert.match(comp, /isBugButtonHidden\(pathname\)/); assert.match(comp, /storage\.from\('documents'\)\.upload/);
  assert.match(comp, /j\.setupNeeded/);
});

test('bug button: hides while <body data-welcome-open> is set, via MutationObserver (no polling)', () => {
  const attrs = new Set(); let observer = null;
  const body = { hasAttribute: (a) => attrs.has(a) };
  class MO { constructor(cb) { this.cb = cb; observer = this; } observe(t, o) { this.opts = o; } disconnect() { this.off = true; } }
  const seen = []; const stop = watchCovered(body, (v) => seen.push(v), MO);
  assert.deepEqual(observer.opts, { attributes: true, attributeFilter: [COVER_ATTR] });
  attrs.add(COVER_ATTR); observer.cb(); attrs.delete(COVER_ATTR); observer.cb();
  assert.deepEqual(seen, [false, true, false]);
  stop(); assert.equal(observer.off, true);
  assert.equal(COVER_ATTR, 'data-welcome-open');
  const comp = readFileSync('app/components/ReportBugButton.js', 'utf8');
  assert.match(comp, /watchCovered\(document\.body, setCovered\)/); assert.match(comp, /open \|\| covered \? 'none'/);
  assert.doesNotMatch(comp, /setInterval/);
});
