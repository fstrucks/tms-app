// E3: export link tokens, the no-sign-in page and part downloads, link events, and the owner email.
// No real email: the Postmark token is removed and every network call to Postmark is blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fakeExportSupabase } from './fakeExportSupabase.mjs';
import * as L from '../../app/lib/companyExportLink.js';
import * as S from '../../app/lib/companyExportServer.js';
import { hashToken, partObject } from '../../app/lib/companyExport.js';
import { postCompanyExport, cronCompanyExport, getExportPart } from '../../app/lib/companyExportRoutes.js';
import { PUBLIC_LEGAL_PATHS } from '../../app/lib/legalRoutes.js';

delete process.env.POSTMARK_SERVER_TOKEN;
globalThis.fetch = async (u) => { throw new Error(`blocked network in tests: ${u}`); };

const T0 = new Date('2026-11-01T15:00:00Z');
const ENV = { POSTMARK_SERVER_TOKEN: 'fake-token-for-tests', APP_BASE_URL: 'https://app.example.test', EXPORT_LINK_SECRET: 'fake-secret', CRON_SECRET: 'test-secret' };
const A = 'a0000000-0000-4000-8000-00000000000a';
const JOB = 'j0000000-0000-4000-8000-000000000001';

function readyWorld(over = {}) {
  const parts = [1, 2, 3].map((n) => ({ n, object: partObject(JOB, n), bytes: 1000 * n, sha256: 'x' }));
  const sb = fakeExportSupabase({
    tables: {
      company_profiles: [{ id: A, owner_id: 'u-owner' }],
      export_jobs: [{ id: JOB, company_profile_id: A, requested_by: 'u-owner', trigger: 'user', status: 'ready', deliver_to: 'owner@example.test', parts, file_count: 4, missing_count: 1, created_at: '2026-11-01T14:00:00Z', completed_at: '2026-11-01T14:30:00Z', expires_at: '2026-11-08T14:30:00Z', cleaned_at: null, token_hash: null, cursor: { lease: '', lease_until: null }, ...over }],
      export_link_events: [],
    },
    users: { 'u-owner': { id: 'u-owner', email: 'owner@example.test' } },
  });
  for (const p of parts) sb.buckets['company-exports'].set(p.object, Buffer.alloc(p.bytes));
  return sb;
}
const fakeSend = () => { const sent = []; const send = async (m) => { sent.push(m); return { messageId: `m${sent.length}` }; }; return { sent, send }; };
const hdrs = (ip = '203.0.113.7') => new Headers({ 'x-forwarded-for': `${ip}, 10.0.0.1`, 'user-agent': 'TestAgent/1.0 ' + 'x'.repeat(400) });
const job = (sb) => sb.db.export_jobs[0];
test.beforeEach(() => L._resetLimiter());

test('email: hash-only storage, wording, default From, owner only, no CC, sent once', async () => {
  const sb = readyWorld(); const f = fakeSend();
  const r = await L.deliverExport(sb, JOB, { now: T0, env: ENV, send: f.send });
  assert.equal(r.sent, true);
  assert.equal(f.sent.length, 1);
  const m = f.sent[0];
  assert.equal(m.from, 'noreply@fstrucks.com');
  assert.deepEqual(m.to, ['owner@example.test']); assert.deepEqual(m.cc, []);
  const token = /\/export\/([A-Za-z0-9_-]{43})\b/.exec(m.body)[1];
  assert.match(job(sb).token_hash, /^[0-9a-f]{64}$/);
  assert.equal(job(sb).token_hash, hashToken(token));
  assert.ok(!JSON.stringify(sb.db).includes(token), 'raw token is never stored');
  assert.match(m.body, /https:\/\/app\.example\.test\/export\//);
  assert.match(m.body, /Big accounts arrive as many parts/);
  assert.match(m.body, /3 parts/);
  assert.match(m.body, /November 8, 2026/);
  assert.match(m.body, /FMCSA.*6 months to 5 years/s); assert.match(m.body, /IRS.*3 to 7 years/s); assert.match(m.body, /permanently removes/);
  for (const w of [/\bbots?\b/i, /\bAI\b/, /grok/i, /claude|openai|gpt|cursor|vercel|supabase|postmark/i]) { assert.doesNotMatch(m.body, w); assert.doesNotMatch(m.subject, w); }
  assert.equal(sb.db.export_link_events.filter((e) => e.kind === 'email_sent').length, 1);
  assert.equal((await L.deliverExport(sb, JOB, { now: T0, env: ENV, send: f.send })).already, true);
  assert.equal(f.sent.length, 1, 'no second send');
  assert.equal(L.COUNTS_TOWARD_SEND_CAP, false);
  assert.ok(!('packet_sends' in sb.db) && !('coi_requests' in sb.db), 'no send-cap rows written');
});

test('email: refused send drops the link and retries up to 3 times; unknown result never retries', async () => {
  const sb = readyWorld(); let n = 0;
  const bad = async () => { n += 1; return { error: 'refused', code: 406 }; };
  for (let i = 0; i < 4; i += 1) await L.deliverExport(sb, JOB, { now: T0, env: ENV, send: bad });
  assert.equal(n, 3); assert.equal(job(sb).token_hash, null); assert.equal(job(sb).cursor.mail_attempts, 3);
  const sb2 = readyWorld(); let u = 0;
  const unk = async () => { u += 1; return { error: 'timeout', unknown: true }; };
  await L.deliverExport(sb2, JOB, { now: T0, env: ENV, send: unk }); await L.deliverExport(sb2, JOB, { now: T0, env: ENV, send: unk });
  assert.equal(u, 1); assert.ok(job(sb2).cursor.mail_unknown);
});

test('email: skipped when not ready, cleaned, no address, no mail config, or another sender holds the lease', async () => {
  const f = fakeSend();
  for (const over of [{ status: 'running' }, { cleaned_at: '2026-11-02T00:00:00Z' }, { deliver_to: null }]) assert.equal((await L.deliverExport(readyWorld(over), JOB, { now: T0, env: ENV, send: f.send })).ok, false);
  assert.equal((await L.deliverExport(readyWorld(), JOB, { now: T0, env: { ...ENV, POSTMARK_SERVER_TOKEN: '' }, send: f.send })).code, 'mail_not_configured');
  assert.equal((await L.deliverExport(readyWorld({ cursor: { lease: 'other', lease_until: '2026-11-01T15:01:00Z' } }), JOB, { now: T0, env: ENV, send: f.send })).busy, true);
  assert.equal(f.sent.length, 0);
});

async function linked(over) { const sb = readyWorld(over); const l = await L.issueLink(sb, job(sb), { now: T0, env: ENV }); return { sb, token: l.token }; }

test('page: lists parts with names, sizes, expiry; logs a hashed IP and a short user agent', async () => {
  const { sb, token } = await linked();
  const r = await L.exportLinkPage(sb, token, { headers: hdrs(), now: T0, env: ENV });
  assert.equal(r.status, 200);
  assert.equal(r.view.partCount, 3);
  assert.deepEqual(r.view.parts.map((p) => p.name), ['powerhaul-export-part-1-of-3.zip', 'powerhaul-export-part-2-of-3.zip', 'powerhaul-export-part-3-of-3.zip']);
  assert.deepEqual(r.view.parts.map((p) => p.bytes), [1000, 2000, 3000]);
  assert.equal(r.view.expiresAt, '2026-11-08T14:30:00Z');
  const e = sb.db.export_link_events[0];
  assert.equal(e.kind, 'link_opened'); assert.match(e.ip_hash, /^[0-9a-f]{64}$/); assert.equal(e.user_agent.length, 300);
  assert.ok(!JSON.stringify(sb.db.export_link_events).includes('203.0.113.7'), 'no raw IP');
  assert.ok(!JSON.stringify(r.view).includes('exports/'), 'no storage paths on the page');
});

test('page: unknown, malformed, expired, cleaned and not-ready links are the same 404; expired hits are logged', async () => {
  const { sb } = await linked();
  for (const t of ['nope', 'A'.repeat(43), '../../etc', null]) assert.deepEqual(await L.exportLinkPage(sb, t, { headers: hdrs(), now: T0, env: ENV }), { status: 404 });
  assert.equal(sb.db.export_link_events.length, 0);
  const late = await linked();
  assert.deepEqual(await L.exportLinkPage(late.sb, late.token, { headers: hdrs(), now: new Date('2026-11-08T14:30:00Z'), env: ENV }), { status: 404 });
  assert.equal(late.sb.db.export_link_events[0].kind, 'expired_hit');
  for (const over of [{ cleaned_at: '2026-11-02T00:00:00Z' }]) { const x = await linked(); Object.assign(job(x.sb), over); assert.equal((await L.exportLinkPage(x.sb, x.token, { headers: hdrs(), now: T0, env: ENV })).status, 404); }
  const nr = readyWorld({ status: 'running' }); assert.equal((await L.issueLink(nr, job(nr), { now: T0, env: ENV })).ok, false);
});

test('a new link replaces the old one', async () => {
  const { sb, token } = await linked();
  const again = await L.issueLink(sb, job(sb), { now: T0, env: ENV });
  assert.equal((await L.exportLinkPage(sb, token, { headers: hdrs(), now: T0, env: ENV })).status, 404);
  assert.equal((await L.exportLinkPage(sb, again.token, { headers: hdrs(), now: T0, env: ENV })).status, 200);
});

test('part download: short signed URL with a file name, logged; bad part numbers 404', async () => {
  const { sb, token } = await linked();
  const r = await L.exportPartUrl(sb, token, '2', { headers: hdrs(), now: T0, env: ENV });
  assert.equal(r.status, 302);
  assert.match(r.location, /expires=300\b/); assert.match(r.location, /download=powerhaul-export-part-2-of-3\.zip/);
  assert.equal(sb.db.export_link_events.at(-1).kind, 'url_minted');
  for (const n of ['0', '4', '1.5', 'x', '-1']) assert.equal((await L.exportPartUrl(sb, token, n, { headers: hdrs(), now: T0, env: ENV })).status, 404);
  const res = await getExportPart(new Request('https://x.test/', { headers: hdrs() }), token, '1', { admin: sb, now: T0, env: ENV });
  assert.equal(res.status, 302); assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0'); assert.equal(res.headers.get('referrer-policy'), 'no-referrer'); assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const miss = await getExportPart(new Request('https://x.test/', { headers: hdrs() }), 'nope', '1', { admin: sb, now: T0, env: ENV });
  assert.equal(miss.status, 404); assert.equal(miss.headers.get('cache-control'), 'no-store, max-age=0');
});

test('rate limits: per IP (also for unknown tokens) and per job signed URLs', async () => {
  const { sb, token } = await linked();
  let last;
  for (let i = 0; i <= L.HITS_PER_IP_PER_10_MIN; i += 1) last = await L.exportLinkPage(sb, 'nope', { headers: hdrs('198.51.100.1'), now: T0, env: ENV });
  assert.equal(last.status, 429);
  assert.equal((await L.exportLinkPage(sb, token, { headers: hdrs('198.51.100.2'), now: T0, env: ENV })).status, 200, 'other IPs unaffected');
  assert.equal((await L.exportLinkPage(sb, token, { headers: hdrs('198.51.100.1'), now: new Date(+T0 + 11 * 60_000), env: ENV })).status, 200, 'window passes');
  for (let i = 0; i < L.MINTS_PER_JOB_PER_HOUR; i += 1) sb.db.export_link_events.push({ id: `e${i}`, job_id: JOB, kind: 'url_minted', at: T0.toISOString() });
  assert.equal((await L.exportPartUrl(sb, token, '1', { headers: hdrs('198.51.100.9'), now: T0, env: ENV })).status, 429);
});

test('ip hash needs a server secret and never equals a plain hash of the IP', () => {
  assert.equal(L.ipHash('203.0.113.7', {}), null);
  assert.notEqual(L.ipHash('203.0.113.7', ENV), hashToken('203.0.113.7'));
  assert.equal(L.clientIp(hdrs()), '203.0.113.7');
});

test('the cron sweep retries unsent link emails and skips sent ones', async () => {
  const w = readyWorld(); const f = fakeSend();
  w.db.export_jobs.push({ ...structuredClone(job(w)), id: 'j2', cursor: { lease: '', mail_sent_at: '2026-11-01T14:31:00Z' } });
  const res = await (await cronCompanyExport(new Request('https://x.test/api/cron/company-export', { headers: { authorization: 'Bearer test-secret' } }), { admin: w, env: ENV, now: T0, mailDeps: { send: f.send } })).json();
  assert.deepEqual(res.mailed.map((m) => m.id), [JOB]);
  assert.equal(f.sent.length, 1);
});

test('owner can ask for a fresh link; others cannot', async () => {
  const sb = readyWorld();
  const users = { 'tok-owner': { id: 'u-owner', email: 'owner@example.test' }, 'tok-m1': { id: 'u-m1' } };
  const mkUserClient = () => ({ auth: { getUser: async (t) => (users[t] ? { data: { user: users[t] }, error: null } : { data: null, error: { status: 401, message: 'bad' } }) } });
  const rq = (tok) => new Request('https://x.test/api/company-export', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'link' }) });
  const deps = { admin: sb, mkUserClient, env: ENV, now: T0 };
  const ok = await postCompanyExport(rq('tok-owner'), deps);
  assert.equal(ok.status, 200);
  const { url } = await ok.json();
  assert.match(url, /^https:\/\/app\.example\.test\/export\/[A-Za-z0-9_-]{43}$/);
  assert.equal(job(sb).token_hash, hashToken(url.split('/').pop()));
  assert.equal((await postCompanyExport(rq('tok-m1'), deps)).status, 403);
  assert.equal(sb.db.export_jobs.length, 1, 'asking for a link does not start a new export');
});

test('startExportForDeletion: owner email, no daily limit, deletion trigger', async () => {
  const sb = readyWorld();
  sb.db.export_jobs = [0, 1, 2].map((i) => ({ id: `old${i}`, company_profile_id: A, requested_by: 'u-owner', status: 'ready', created_at: new Date(+T0 - 3600_000).toISOString(), cursor: {} }));
  const normal = await S.startExport(sb, { id: 'u-owner', email: 'owner@example.test' }, { now: T0 });
  assert.equal(normal.status, 429);
  sb.db.account_deletion_requests = [{ id: 'dr1', user_id: 'u-owner', purge_after: '2026-11-15T15:00:00Z', cancelled_at: null, completed_at: null }];
  const r = await S.startExportForDeletion(sb, A, { now: T0 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const j = sb.db.export_jobs.find((x) => x.id === r.jobId);
  assert.equal(j.trigger, 'deletion'); assert.equal(j.deliver_to, 'owner@example.test');
  assert.equal((await S.startExportForDeletion(sb, 'nope', { now: T0 })).status, 404);
});

test('public page wiring: noindex, no referrer, no-store headers; shell hidden; nothing in the UI calls the deletion hook', () => {
  const require = createRequire(import.meta.url);
  const cfg = require('../../next.config.js');
  return cfg.headers().then((rules) => {
    for (const src of ['/export/:path*', '/api/export-link/:path*']) {
      const h = Object.fromEntries(rules.find((r) => r.source === src).headers.map((x) => [x.key, x.value]));
      assert.match(h['Cache-Control'], /no-store/); assert.equal(h['Referrer-Policy'], 'no-referrer'); assert.match(h['X-Robots-Tag'], /noindex/);
    }
    assert.ok(PUBLIC_LEGAL_PATHS.includes('/export'));
    const page = readFileSync(new URL('../../app/export/[token]/page.js', import.meta.url), 'utf8');
    assert.match(page, /robots: \{ index: false/); assert.match(page, /referrer: 'no-referrer'/); assert.match(page, /notFound\(\)/);
    assert.match(page, /MANY_PARTS_NOTE/); assert.match(L.MANY_PARTS_NOTE, /many parts. Download each one/i);
    assert.ok(existsSync(new URL('../../app/api/export-link/[token]/[n]/route.js', import.meta.url)));
    assert.doesNotMatch(readFileSync(new URL('../../app/components/DangerZone.js', import.meta.url), 'utf8'), /startExportForDeletion/);
  });
});
