// E4: the owner's deletion confirm starts the automatic export; Danger zone export panel. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeExportSupabase } from './fakeExportSupabase.mjs';
// Never send real email from tests.
delete process.env.POSTMARK_SERVER_TOKEN;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { if (/postmarkapp|\.test\//.test(String(u))) throw new Error(`blocked network in tests: ${u}`); return realFetch(u, o); };
import { postAccountDeletion, runDueDeletions, startDeletionExport } from '../../app/lib/accountDeletionServer.js';
import * as S from '../../app/lib/companyExportServer.js';
import { LINK_DAYS_AFTER_PURGE } from '../../app/lib/companyExport.js';
import { EXPORT_LINK_DAYS_AFTER_PURGE, ownerWarnings, recordWarnings, scheduledMessage, exportNotStartedMessage } from '../../app/lib/accountDeletion.js';
import { MANY_PARTS_NOTE as LINK_NOTE } from '../../app/lib/companyExportLink.js';
import { MANY_PARTS_NOTE, exportErrorText, pollDelayMs, shouldPoll, statusLine } from '../../app/lib/companyExportCopy.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const ids = { A: 'a0000000-0000-4000-8000-00000000000a', o: 'u-owner', m: 'u-member' };
const owner = { id: ids.o, email: 'owner@example.test', last_sign_in_at: '2026-10-28T14:00:00.000Z' };

function world(extra = {}) {
  return fakeExportSupabase({
    unique: { export_jobs: [{ cols: ['company_profile_id'], where: (r) => ['queued', 'running'].includes(r.status) }] },
    tables: {
      company_profiles: [{ id: ids.A, owner_id: ids.o, legal_name: 'FAKE Trucking LLC', is_demo: false, deletion_locked: false }],
      company_members: [{ profile_id: ids.A, user_id: ids.o, role: 'owner' }],
      account_deletion_requests: [], export_jobs: [], ...extra.tables,
    },
    users: { [ids.o]: owner },
  });
}
const req = (body) => new Request('https://app.example.test/api/account/deletion', { method: 'POST', headers: { authorization: 'Bearer fake-test-session', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const asUser = (user) => () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } });

test('owner final confirm: request row first, then the export starts (deletion trigger), runs after the response, signs out', async () => {
  const sb = world(); const later = []; const order = [];
  const res = await postAccountDeletion(req({ confirm: 'DELETE' }), {
    admin: sb, mkUserClient: asUser(owner), waitUntil: (p) => later.push(p),
    startExportForDeletion: async (admin, id, o) => { order.push(['export', admin.db.account_deletion_requests.length]); return S.startExportForDeletion(admin, id, o); },
    runExport: async (_a, id) => order.push(['run', id]),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.scheduled, true); assert.equal(body.sign_out, true);
  assert.equal(body.export.started, true);
  assert.deepEqual(order[0], ['export', 1], 'the deletion request existed before the export started');
  const job = sb.db.export_jobs[0];
  assert.equal(job.trigger, 'deletion'); assert.equal(job.deletion_request_id, sb.db.account_deletion_requests[0].id);
  assert.equal(job.purge_at, sb.db.account_deletion_requests[0].purge_after); assert.equal(job.deliver_to, owner.email);
  await Promise.all(later); assert.deepEqual(order[1], ['run', job.id]);
  assert.match(body.message, /A full export has started; the download link will be emailed to you\. It does not cancel the deletion\./);
});

test('first tap does nothing on the server: a wrong or missing confirm starts no export and schedules nothing', async () => {
  const sb = world(); let starts = 0;
  const res = await postAccountDeletion(req({}), { admin: sb, mkUserClient: asUser(owner), startExportForDeletion: async () => { starts += 1; return {}; }, runExport: async () => {} });
  assert.equal(res.status, 400); assert.equal(starts, 0);
  assert.equal(sb.db.account_deletion_requests.length, 0); assert.equal(sb.db.export_jobs.length, 0);
});

test('export start fails (budget, throw): deletion is still scheduled, owner stays signed in, message says so, logged', async () => {
  for (const failing of [
    async () => ({ status: 503, body: { error: 'Exports are busy right now. Try again later.', code: 'storage_budget' } }),
    async () => { throw new Error('boom'); },
  ]) {
    const sb = world(); const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
    let res; try { res = await postAccountDeletion(req({ confirm: 'owner@example.test' }), { admin: sb, mkUserClient: asUser(owner), startExportForDeletion: failing, runExport: async () => assert.fail('no run') }); }
    finally { console.error = orig; }
    const body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.scheduled, true);
    assert.equal(sb.db.account_deletion_requests.length, 1, 'request kept');
    assert.equal(body.sign_out, false); assert.equal(body.export.started, false);
    assert.match(body.message, /could not be started\. The deletion is still scheduled/);
    assert.match(body.message, /Download full export/);
    assert.ok(errs.some((e) => /\[account-deletion\] export not started/.test(e)));
  }
});

test('already scheduled: confirming again starts no second export', async () => {
  const sb = world(); const deps = { admin: sb, mkUserClient: asUser(owner), waitUntil: () => {}, runExport: async () => {} };
  await postAccountDeletion(req({ confirm: 'DELETE' }), deps);
  let starts = 0;
  const again = await (await postAccountDeletion(req({ confirm: 'DELETE' }), { ...deps, startExportForDeletion: async () => { starts += 1; return {}; } })).json();
  assert.equal(again.already, true); assert.equal(starts, 0); assert.equal(sb.db.export_jobs.length, 1);
});

test('demo/immediate owner deletion does not start an export', async () => {
  const sb = world({ tables: { company_profiles: [{ id: ids.A, owner_id: ids.o, legal_name: 'FAKE Demo', is_demo: true, deletion_locked: false }] } });
  let starts = 0;
  sb.rpc = async () => ({ data: { cancelled: true }, error: null });
  await postAccountDeletion(req({ confirm: 'DELETE' }), { admin: sb, mkUserClient: asUser(owner), startExportForDeletion: async () => { starts += 1; return {}; }, runExport: async () => {} });
  assert.equal(starts, 0);
});

test('purge hold: the owner path with an open export job holds the purge until the job is done', async () => {
  const sb = world();
  await postAccountDeletion(req({ confirm: 'DELETE' }), { admin: sb, mkUserClient: asUser(owner), waitUntil: () => {}, runExport: async () => {} });
  const dr = sb.db.account_deletion_requests[0]; const job = sb.db.export_jobs[0];
  dr.purge_after = new Date(Date.parse(job.created_at) + 60_000).toISOString(); // due while the job is still open
  let executed = 0;
  const held = await runDueDeletions(sb, { exportHold: undefined }, new Date(Date.parse(job.created_at) + 3600_000));
  assert.deepEqual(held.results, [{ user_id: ids.o, ok: false, held_for_export: job.id }]);
  assert.equal(dr.completed_at ?? null, null);
  job.status = 'ready';
  sb.rpc = async () => { executed += 1; return { data: { cancelled: true }, error: null }; };
  const after = await runDueDeletions(sb, { exportHold: undefined }, new Date(Date.parse(job.created_at) + 3600_000));
  assert.equal(executed, 1, 'purge runs once the export is no longer open'); assert.equal(after.results[0].held_for_export, undefined);
});

test('startDeletionExport never throws and reports a missing owner email', async () => {
  const sb = world(); sb.db.company_profiles[0].owner_id = 'u-nobody';
  const r = await startDeletionExport(sb, ids.A, { runExport: async () => {} , startExportForDeletion: S.startExportForDeletion });
  assert.deepEqual(r, { started: false, code: 'no_owner_email' });
});

test('warnings: records to keep, permanent, automatic export does not cancel, 7 days after purge', () => {
  assert.equal(EXPORT_LINK_DAYS_AFTER_PURGE, LINK_DAYS_AFTER_PURGE);
  const w = ownerWarnings({ companyName: 'FAKE Co' }).join(' ');
  assert.match(w, /FMCSA rules call for 6 months to 5 years/); assert.match(w, /IRS 3 to 7 years/);
  assert.match(w, /permanently removes the company’s data/);
  assert.match(w, /a full export of the company starts automatically and a download link is emailed to you\. The export does not cancel the deletion\. The link and files stay available for 7 days after the company is deleted\./);
  assert.match(ownerWarnings({ demo: true }).join(' '), /no automatic export is made/);
  assert.equal(recordWarnings().length, 3);
  assert.match(scheduledMessage({ purgeAt: '2026-11-11T00:00:00.000Z' }), /You are signed out now\. Sign in again before that date to cancel\.$/);
  assert.doesNotMatch(scheduledMessage({ purgeAt: '2026-11-11T00:00:00.000Z', exportStarted: false }), /signed out now/);
  assert.match(exportNotStartedMessage(), /Signing in again later cancels the deletion/);
  for (const t of [w, exportNotStartedMessage()]) assert.doesNotMatch(t, /\bbot\b|\bAI\b|assistant/i);
});

test('panel copy and polling helpers', () => {
  assert.equal(LINK_NOTE, MANY_PARTS_NOTE);
  assert.equal(pollDelayMs(0), 5000); assert.equal(pollDelayMs(59_999), 5000); assert.equal(pollDelayMs(60_000), 15000);
  assert.equal(shouldPoll({ status: 'queued' }), true); assert.equal(shouldPoll({ status: 'running' }), true);
  for (const s of ['ready', 'failed', 'expired']) assert.equal(shouldPoll({ status: s }), false);
  assert.equal(shouldPoll(null), false);
  assert.match(statusLine({ status: 'queued' }), /queued/);
  assert.match(statusLine({ status: 'running', partCount: 2 }), /Building the export… 2 parts finished/);
  assert.match(statusLine({ status: 'ready', partCount: 3 }), /Export ready: 3 parts\. Big accounts arrive as many parts\. Download each one/);
  assert.match(statusLine({ status: 'failed' }), /failed\. Start a new one/);
  assert.match(exportErrorText({ status: 429 }, {}), /3 exports a day/);
  assert.match(exportErrorText({ status: 503 }, { code: 'storage_budget', error: 'Exports are busy right now. Try again later.' }), /busy/);
  assert.match(exportErrorText({ status: 500 }, {}), /Couldn’t start the export/);
});

test('Danger zone: export panel only for owners, uses the export routes, polls, fresh link; confirm dialog shows record warnings', () => {
  const zone = read('app/components/DangerZone.js');
  assert.match(zone, /status\?\.role === 'owner' && !status\.signedOut && <CompanyExportPanel \/>/);
  assert.match(zone, /data-testid="delete-confirm-records"/);
  const dialog = zone.slice(zone.indexOf('role="alertdialog"'));
  assert.match(dialog, /recordWarnings\(/);
  assert.doesNotMatch(zone, /startExportForDeletion/);
  const p = read('app/components/CompanyExportPanel.js');
  assert.match(p, /'\/api\/company-export'/); assert.match(p, /action: 'link'/);
  assert.match(p, /Download full export/); assert.match(p, /Get a fresh link/); assert.match(p, /Export company data/);
  assert.match(p, /shouldPoll\(job\)/); assert.match(p, /clearTimeout/); assert.match(p, /document\.hidden/);
  assert.match(p, /exportErrorText\(res, body\)/);
  for (const src of [p, zone]) { assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/); assert.doesNotMatch(src, /\bbot\b|\bAI\b/); }
  assert.doesNotMatch(p, /node:crypto|companyExportServer|companyExportLink/, 'browser-safe imports only');
});
