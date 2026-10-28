// Account deletion rules, legal pages, and the session-checked route. No live users are deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import {
  CONFIRM_WORD, FORMER_MEMBER_LABEL, GRACE_DAYS, GRACE_MS, PROTECTED_COMPANY_ID, SUPPORT_EMAIL,
  cancelledMessage, classifyMemberObject, confirmationMatches, cronAuthorized,
  deletionKind, formatWhen, isDemoCompany, isProtectedCompany, memberKeepsLogin,
  multiCompanyMessage, ownerWarnings, protectedCompanyMessage, purgeAfter,
  retainedStoragePath, scheduledMessage, shouldCancelOnSignIn,
} from '../../app/lib/accountDeletion.js';
import { formatUpdated, renderLegalMarkdown, safeHref } from '../../app/lib/legalMarkdown.js';
import { PUBLIC_LEGAL_PATHS, isPublicLegalPath } from '../../app/lib/legalRoutes.js';
import { applyStoragePlan, baselineSignInAt, listStoragePrefix } from '../../app/lib/accountDeletionServer.js';
import { GET, POST } from '../../app/api/account/deletion/route.js';
import { GET as CRON } from '../../app/api/cron/account-deletion/route.js';
import { isBugButtonHidden } from '../../app/lib/bugReport.js';
import { shouldShowWelcome } from '../../app/lib/welcome.js';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SQL = read('supabase/migrations/20261028000100_account_deletion.sql');
const CHECK = read('supabase/one-off/20261028_account_deletion_check.sql');
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000a2';
const OTHER = '00000000-0000-4000-8000-0000000000a9';

test('typed confirmation matches DELETE or the signed-in email only', () => {
  assert.equal(CONFIRM_WORD, 'DELETE');
  assert.equal(confirmationMatches('DELETE', 'a@b.c'), true);
  assert.equal(confirmationMatches('  DELETE  ', 'a@b.c'), true);
  assert.equal(confirmationMatches('delete', 'a@b.c'), false);
  assert.equal(confirmationMatches('Delete', 'a@b.c'), false);
  assert.equal(confirmationMatches('', 'a@b.c'), false);
  assert.equal(confirmationMatches('  ', 'a@b.c'), false);
  assert.equal(confirmationMatches('person@pwrstrong.net', 'Person@Pwrstrong.net'), true);
  assert.equal(confirmationMatches('other@pwrstrong.net', 'person@pwrstrong.net'), false);
  assert.equal(confirmationMatches('person@pwrstrong.net', ''), false);
});

test('grace period is 14 days from the request, as an exact duration', () => {
  const start = new Date('2026-10-28T15:04:00.000Z');
  const end = purgeAfter(start);
  assert.equal(GRACE_DAYS, 14);
  assert.equal(end.toISOString(), '2026-11-11T15:04:00.000Z');
  assert.equal(end.getTime() - start.getTime(), GRACE_MS);
  assert.equal(purgeAfter('not-a-date'), null);
  assert.equal(formatWhen('2026-11-11T15:04:00.000Z'), 'November 11, 2026');
});

test('only is_demo deletes immediately; the company name does not', () => {
  assert.equal(isDemoCompany({ legal_name: 'FS Trucks', is_demo: false }), false);
  assert.equal(isDemoCompany({ legal_name: 'Latest Logistics' }), false);
  assert.equal(isDemoCompany({ legal_name: 'Greatest Hauling' }), false);
  assert.equal(isDemoCompany({ legal_name: 'Demo Trucking', is_demo: false }), false);
  assert.equal(isDemoCompany({ dba_name: 'Test Co', is_demo: false }), false);
  assert.equal(isDemoCompany({ legal_name: 'FS Trucks', is_demo: true }), true);
  assert.equal(isProtectedCompany({ id: PROTECTED_COMPANY_ID, deletion_locked: false }), true);
  assert.equal(isProtectedCompany({ id: '00000000-0000-4000-8000-0000000000aa', deletion_locked: true }), true);
  assert.equal(isProtectedCompany({ id: '00000000-0000-4000-8000-0000000000aa', deletion_locked: false }), false);
  assert.match(protectedCompanyMessage(), /can't be deleted from the app/);
  assert.match(protectedCompanyMessage(), new RegExp(SUPPORT_EMAIL.replace('.', '\\.')));
  assert.match(multiCompanyMessage(), /more than one company/);
  assert.match(multiCompanyMessage(), new RegExp(SUPPORT_EMAIL.replace('.', '\\.')));
  assert.deepEqual(deletionKind({ ownsCompany: false, demo: false }), { kind: 'member', immediate: true, graceDays: 0 });
  assert.equal(deletionKind({ ownsCompany: true, demo: true }).immediate, true);
  assert.equal(deletionKind({ ownsCompany: true, demo: true }).reason, 'demo');
  assert.equal(deletionKind({ ownsCompany: true, demo: false }).immediate, false);
  assert.equal(deletionKind({ ownsCompany: true, demo: false }).graceDays, 14);
});

test('teammates keep a sign-in only when they have another company', () => {
  assert.equal(memberKeepsLogin({}), false);
  assert.equal(memberKeepsLogin({ otherMemberships: 0, ownsOtherCompany: false }), false);
  assert.equal(memberKeepsLogin({ otherMemberships: 1 }), true);
  assert.equal(memberKeepsLogin({ ownsOtherCompany: true }), true);
});

test('a newer sign-in cancels a pending company deletion; the same sign-in does not', () => {
  const base = '2026-10-28T15:00:00.000Z';
  assert.equal(shouldCancelOnSignIn({ baselineSignInAt: base, currentSignInAt: base }), false);
  assert.equal(shouldCancelOnSignIn({ baselineSignInAt: base, currentSignInAt: '2026-10-28T16:00:00.000Z' }), true);
  assert.equal(shouldCancelOnSignIn({ baselineSignInAt: base, currentSignInAt: '2026-10-28T14:00:00.000Z' }), false);
  assert.equal(shouldCancelOnSignIn({ baselineSignInAt: null, currentSignInAt: base }), false);
  assert.match(cancelledMessage(), /cancelled because you signed in/);
  assert.match(scheduledMessage({ purgeAt: '2026-11-11T00:00:00.000Z', companyName: 'FS Trucks' }), /November 11, 2026/);
  assert.match(ownerWarnings({ companyName: 'FS Trucks' }).join(' '), /Transfer ownership first/);
  const before = ownerWarnings({ companyName: 'FS Trucks' })[0];
  assert.equal(before, 'If you delete “FS Trucks”, it is scheduled for deletion 14 days after you confirm. Sign in again before that day to cancel, or tap Cancel here while you are still signed in.');
  assert.doesNotMatch(before, /from now/);
  const demoLine = ownerWarnings({ companyName: 'FS Trucks', demo: true })[0];
  assert.match(demoLine, /If you delete “FS Trucks”, it is marked as a demo, so it will be deleted right away/);
  assert.doesNotMatch(demoLine, /is deleted right away/);
  const zone = read('app/components/DangerZone.js');
  const pendingAt = zone.indexOf('{!done && pending &&');
  const formAt = zone.indexOf('!pending && !status.blocked');
  assert.ok(pendingAt > 0 && formAt > pendingAt);
  const pendingBlock = zone.slice(pendingAt, formAt);
  assert.match(pendingBlock, /purge_after/);
  assert.match(pendingBlock, /Cancel deletion/);
  assert.doesNotMatch(pendingBlock, /status\.warnings/);
  const formBlock = zone.slice(formAt);
  assert.match(formBlock, /status\.warnings/);
  assert.doesNotMatch(formBlock, /Cancel deletion/);
  assert.match(zone, /setConfirming\(true\)/);
  assert.match(zone, /data-testid="delete-final-confirm"/);
  assert.match(zone, /role="alertdialog"/);
  assert.match(zone, /Delete my account\? This can't be undone\./);
  assert.match(zone, /It is scheduled for deletion \$\{status\.grace_days \|\| 14\} days after you confirm/);
  assert.match(zone, /It will be deleted right away\. This can't be undone\./);
  assert.match(zone, /e\.key === 'Escape'/);
  assert.match(zone, /data-testid="delete-confirm-backdrop"/);
  assert.match(zone, /busy \? 'Working…' : 'Delete'/);
  assert.doesNotMatch(zone, /busy \? 'Working…' : \(status\.role/);
  const firstClick = zone.slice(zone.indexOf('data-testid="delete-account-button"'), zone.indexOf('data-testid="delete-final-confirm"'));
  assert.match(firstClick, /setConfirming\(true\)/);
  assert.doesNotMatch(firstClick, /post\(\{ confirm/);
});

test('personal files are bug-report screenshots and anything not kept for the company', () => {
  const uid = MEMBER;
  const kept = new Set([`${uid}/1-bol.pdf`]);
  assert.equal(classifyMemberObject({ path: `${uid}/bug-reports/1.png`, uid, keptPaths: kept }), 'delete');
  assert.equal(classifyMemberObject({ path: `${uid}/1-bol.pdf`, uid, keptPaths: kept }), 'reassign');
  assert.equal(classifyMemberObject({ path: `${uid}/9-loose.jpg`, uid, keptPaths: kept }), 'delete');
  assert.equal(classifyMemberObject({ path: `${OWNER}/1-bol.pdf`, uid, keptPaths: kept }), 'ignore');
  assert.equal(retainedStoragePath(OWNER, `${uid}/packets/a.pdf`), `${OWNER}/retained/${uid}/packets/a.pdf`);
  assert.equal(retainedStoragePath(OWNER, `${OWNER}/already.pdf`), `${OWNER}/already.pdf`);
  assert.equal(FORMER_MEMBER_LABEL, 'Former team member');
});

test('markdown renderer escapes html and only allows safe links', () => {
  const doc = renderLegalMarkdown('---\nupdated: 2026-10-28\n---\n\nThis page is being updated.\n\n## Keep\n\n- **Bold** and <script>alert(1)</script>\n- [Site](https://pwrstrong.net/privacy)\n- [Bad](javascript:alert(1))\n');
  assert.equal(doc.updatedLabel, 'October 28, 2026');
  assert.match(doc.html, /This page is being updated\./);
  assert.match(doc.html, /<h2>Keep<\/h2>/);
  assert.match(doc.html, /<strong>Bold<\/strong>/);
  assert.match(doc.html, /&lt;script&gt;/);
  assert.doesNotMatch(doc.html, /<script>/);
  assert.match(doc.html, /href="https:\/\/pwrstrong\.net\/privacy"/);
  assert.doesNotMatch(doc.html, /javascript:/);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('//evil.example'), null);
  assert.equal(safeHref('/privacy'), '/privacy');
  assert.equal(formatUpdated('2026-02-31'), null);
});

test('legal files are placeholders and the public pages do not require a sign-in', () => {
  for (const name of ['privacy', 'terms']) {
    const md = read(`content/legal/${name}.md`);
    assert.match(md, /This page is being updated\./);
    assert.doesNotMatch(md, /Power Strong Solutions LLC collects|we may share|governing law/i);
    const page = read(`app/${name}/page.js`);
    assert.match(page, /export const metadata/);
    assert.match(page, new RegExp(`title: '${name === 'privacy' ? 'Privacy' : 'Terms'}'`));
    assert.doesNotMatch(page, /getSupabase|redirect\(/);
  }
  const del = read('app/delete-account/page.js');
  assert.match(del, /title: 'Delete account'/);
  assert.match(del, /SUPPORT_EMAIL/);
  assert.match(del, /Danger zone/);
  assert.match(del, /GRACE_DAYS/);
  assert.match(del, /more than one company/);
  assert.match(del, /will be deleted right away/);
  assert.match(del, /after you confirm/);
  assert.doesNotMatch(del, /marked as a demo is deleted right away|from now/);
  assert.doesNotMatch(del, /word demo or test|name that happens/i);
  assert.doesNotMatch(del, /getSupabase|redirect\(/);
  assert.equal(existsSync(new URL('middleware.js', root)), false);
  assert.equal(existsSync(new URL('src/middleware.js', root)), false);
  assert.doesNotMatch(read('app/layout.js'), /redirect\(/);
  for (const p of PUBLIC_LEGAL_PATHS) {
    assert.equal(isPublicLegalPath(p), true);
    assert.equal(isBugButtonHidden(p), true);
    assert.equal(shouldShowWelcome({ user: { id: 'u' }, pathname: p, storage: { getItem: () => null } }), false);
  }
  assert.equal(isPublicLegalPath('/loads'), false);
  assert.equal(isBugButtonHidden('/loads/1'), false);
  const footer = read('app/components/LegalFooter.js');
  assert.match(footer, /href="\/privacy"/);
  assert.match(footer, /href="\/terms"/);
  assert.match(footer, /href="\/delete-account"/);
  for (const file of ['app/login/page.js', 'app/forgot-password/page.js', 'app/account/password/page.js', 'app/account/invite/page.js', 'app/account/settings/page.js']) {
    assert.match(read(file), /<LegalFooter/);
  }
  assert.match(read('app/forgot-password/page.js'), /<LegalFooter includeDelete \/>/);
  assert.match(read('app/account/invite/page.js'), /<LegalFooter \/>/);
  assert.match(read('app/account/settings/page.js'), /DangerZone/);
  assert.match(read('app/company/page.js'), /role === 'owner' && <DangerZone/);
  assert.equal(SUPPORT_EMAIL, 'support@pwrstrong.net');
});

function codeOnly(sql) {
  return sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').replace(/'[^']*'/g, "''");
}

test('migration is idempotent, service-role only, and matches the deletion rules', () => {
  assert.match(SQL, /create or replace function public\.account_deletion_apply\(p_user uuid\)/);
  assert.match(SQL, /language plpgsql\s+security definer\s+set search_path = public, pg_temp/);
  assert.match(SQL, /revoke all on function public\.account_deletion_apply\(uuid\) from public/);
  assert.match(SQL, /revoke all on function public\.account_deletion_apply\(uuid\) from authenticated/);
  assert.match(SQL, /grant execute on function public\.account_deletion_apply\(uuid\) to service_role/);
  assert.doesNotMatch(SQL, /grant execute on function public\.account_deletion_apply\(uuid\) to authenticated/);
  assert.match(SQL, /add column if not exists is_demo boolean not null default false/);
  assert.match(SQL, /create table if not exists public\.account_deletion_requests/);
  assert.match(SQL, /create table if not exists public\.former_members/);
  assert.match(SQL, /Former team member/);
  assert.match(SQL, /status = case when l\.status = 'dispatched' then 'booked' else l\.status end/);
  assert.match(SQL, /grace_period/);
  assert.match(SQL, /grace_required/);
  assert.doesNotMatch(SQL, /\\m\(demo\|test\)\\M/);
  assert.match(SQL, /coalesce\(v_profile\.is_demo, false\)/);
  assert.match(SQL, /deletion_locked boolean not null default false/);
  assert.match(SQL, /155fd2a0-11a9-4a3c-8f58-7efab00a188b/);
  assert.match(SQL, /protected_company/);
  assert.match(SQL, /multi_company_member/);
  assert.match(SQL, /last_sign_in_at/);
  assert.match(SQL, /account_deletion_retarget_fk\('company_profiles', 'signed_by', 'auth\.users\(id\)', 'set null', true\)/);
  assert.match(SQL, /set signed_by = null where signed_by = p_user/);
  assert.match(SQL, /auth_user_id = any\(v_ids\)\s+or \(auth_user_id = any\(v_keep\) and user_id = p_user\)/);
  assert.doesNotMatch(SQL, /auth_user_id = any\(v_ids \|\| v_keep\)/);
  assert.match(SQL, /\/retained\//);
  assert.match(SQL, /array\['redacted'\]/);
  assert.match(SQL, /load_packet_sends/);
  assert.match(SQL, /packet_sends/);
  assert.match(SQL, /coi_requests/);
  assert.doesNotMatch(SQL, /delete from public\.facilities/);
  assert.doesNotMatch(SQL, /delete from public\.facility_reviews/);
  assert.match(SQL, /set author_id = null, company_id = null/);
  assert.match(SQL, /enable row level security/);
  assert.match(CHECK, /account_deletion_apply/);
  assert.match(CHECK, /reverts_dispatched_to_booked/);
  assert.match(CHECK, /has_function_privilege\('anon'/);
  assert.match(CHECK, /has_function_privilege\('authenticated'/);
  assert.match(CHECK, /has_function_privilege\('service_role', 'public\.account_deletion_apply\(uuid\)', 'execute'\) as service_role_execute/);
  assert.match(CHECK, /service_role_execute true/);
  assert.match(CHECK, /acl\.grantee = 0/);
  assert.doesNotMatch(CHECK, /grantee in \('anon'/);
  assert.doesNotMatch(codeOnly(CHECK), /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
});

function world({ user, profiles = [], requests = [], rpcResult } = {}) {
  const calls = { rpc: [], deleted: [] };
  const admin = fakeSupabase({ tables: { company_profiles: profiles, account_deletion_requests: requests, account_deletion_storage_jobs: [] } });
  admin.rpc = async (fn, args) => {
    calls.rpc.push({ fn, args });
    if (rpcResult) return rpcResult;
    return { data: { auth_user_ids: [args.p_user], jobs: [], mode: 'member' }, error: null };
  };
  admin.auth.admin = { deleteUser: async (id) => { calls.deleted.push(id); return { error: null }; } };
  admin.storage = { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }), copy: async () => ({ error: null }) }) };
  const uc = fakeSupabase({ user });
  return { calls, deps: { mkUserClient: () => uc, admin } };
}

const post = (body, deps, token = 't') => POST(new Request('http://x/api/account/deletion', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}), { deps });

test('route uses the session user, never a user id in the body', async () => {
  const member = world({ user: { id: MEMBER, email: 'driver@example.test', last_sign_in_at: '2026-10-01T00:00:00.000Z' }, profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: false }] });
  const denied = await post({ confirm: 'DELETE', user_id: OTHER }, member.deps, null);
  assert.equal(denied.status, 401);
  const bad = await post({ confirm: 'delete', user_id: OTHER }, member.deps);
  assert.equal(bad.status, 400);
  assert.equal(member.calls.rpc.length, 0);
  const ok = await post({ confirm: 'DELETE', user_id: OTHER }, member.deps);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.deleted, true);
  assert.equal(body.mode, 'member');
  assert.equal(member.calls.rpc[0].fn, 'account_deletion_apply');
  assert.equal(member.calls.rpc[0].args.p_user, MEMBER);
  assert.deepEqual(member.calls.deleted, [MEMBER]);
});

test('owner schedules 14 days out and does not delete yet; demo deletes now', async () => {
  const ownerUser = { id: OWNER, email: 'owner@example.test', last_sign_in_at: '2026-10-20T00:00:00.000Z' };
  const live = world({ user: ownerUser, profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FS Trucks', dba_name: null, is_demo: false }] });
  const res = await post({ confirm: 'owner@example.test', user_id: MEMBER }, live.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.scheduled, true);
  assert.equal(body.immediate, false);
  assert.equal(body.grace_days, 14);
  assert.equal(body.sign_out, true);
  assert.ok(Math.abs(Date.parse(body.purge_after) - (Date.now() + GRACE_MS)) < 10_000);
  assert.equal(live.calls.rpc.length, 0);
  assert.equal(live.calls.deleted.length, 0);
  assert.equal(live.deps.admin.db.account_deletion_requests[0].user_id, OWNER);
  assert.match(body.message, /Sign in again/);

  const named = world({ user: ownerUser, profiles: [{ id: 'p2', owner_id: OWNER, legal_name: 'Test Hauling', dba_name: 'Demo Trucking', is_demo: false, deletion_locked: false }] });
  const waited = await post({ confirm: 'DELETE' }, named.deps);
  assert.equal(waited.status, 200);
  assert.equal((await waited.json()).scheduled, true);
  assert.equal(named.calls.rpc.length, 0);

  const demo = world({ user: ownerUser, profiles: [{ id: 'p3', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: true, deletion_locked: false }] });
  const gone = await post({ confirm: 'DELETE' }, demo.deps);
  assert.equal(gone.status, 200);
  assert.equal((await gone.json()).deleted, true);
  assert.equal(demo.calls.rpc[0].args.p_user, OWNER);
  assert.deepEqual(demo.calls.deleted, [OWNER]);
});

test('baseline sign-in time falls back to now when the session has none', async () => {
  assert.equal(baselineSignInAt({ last_sign_in_at: '2026-01-01T00:00:00.000Z' }), '2026-01-01T00:00:00.000Z');
  assert.equal(baselineSignInAt({}, new Date('2026-10-28T00:00:00.000Z')), '2026-10-28T00:00:00.000Z');
  assert.equal(baselineSignInAt(null, new Date('2026-10-28T00:00:00.000Z')), '2026-10-28T00:00:00.000Z');
  const before = Date.now();
  const ownerUser = { id: OWNER, email: 'owner@example.test' };
  const live = world({ user: ownerUser, profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: false, deletion_locked: false }] });
  const scheduled = await post({ confirm: 'DELETE' }, live.deps);
  assert.equal(scheduled.status, 200);
  const ownerAt = Date.parse(live.deps.admin.db.account_deletion_requests[0].baseline_sign_in_at);
  assert.ok(ownerAt >= before - 1000 && ownerAt <= Date.now() + 1000);
  const member = world({ user: { id: MEMBER, email: 'driver@example.test' }, profiles: [] });
  const gone = await post({ confirm: 'DELETE' }, member.deps);
  assert.equal(gone.status, 200);
  const memberAt = Date.parse(member.deps.admin.db.account_deletion_requests[0].baseline_sign_in_at);
  assert.ok(memberAt >= before - 1000 && memberAt <= Date.now() + 1000);
});

test('more than one company, a protected company, and a later sign-in do not delete the sign-in', async () => {
  const member = world({
    user: { id: MEMBER, email: 'driver@example.test', last_sign_in_at: '2026-10-01T00:00:00.000Z' },
    profiles: [],
  });
  member.deps.admin.db.company_members = [
    { profile_id: 'p1', user_id: MEMBER },
    { profile_id: 'p2', user_id: MEMBER },
  ];
  const multi = await post({ confirm: 'DELETE' }, member.deps);
  const multiBody = await multi.json();
  assert.equal(multi.status, 409);
  assert.match(multiBody.error, /more than one company/);
  assert.match(multiBody.error, /support@pwrstrong\.net/);
  assert.equal(member.calls.rpc.length, 0);
  assert.equal(member.calls.deleted.length, 0);
  const listed = await GET(new Request('http://x/api/account/deletion', { headers: { authorization: 'Bearer t' } }), { deps: member.deps });
  const listedBody = await listed.json();
  assert.equal(listedBody.blocked, 'multi_company_member');
  assert.match(listedBody.message, /support@pwrstrong\.net/);

  const ownerUser = { id: OWNER, email: 'owner@example.test', last_sign_in_at: '2026-10-20T00:00:00.000Z' };
  const locked = world({ user: ownerUser, profiles: [{ id: 'p9', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: true, deletion_locked: true }] });
  const refused = await post({ confirm: 'DELETE' }, locked.deps);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /can't be deleted from the app/);
  assert.equal(locked.calls.rpc.length, 0);
  const real = world({ user: ownerUser, profiles: [{ id: PROTECTED_COMPANY_ID, owner_id: OWNER, legal_name: 'FS Trucks', is_demo: false, deletion_locked: false }] });
  const hard = await post({ confirm: 'DELETE' }, real.deps);
  assert.equal(hard.status, 409);
  assert.equal(real.calls.deleted.length, 0);

  const sqlSays = world({
    user: { id: MEMBER, email: 'driver@example.test', last_sign_in_at: '2026-10-01T00:00:00.000Z' },
    rpcResult: { data: null, error: { message: 'multi_company_member' } },
  });
  const fromSql = await post({ confirm: 'DELETE' }, sqlSays.deps);
  assert.equal(fromSql.status, 409);
  assert.match((await fromSql.json()).error, /Email support@pwrstrong\.net/);
  assert.equal(sqlSays.calls.deleted.length, 0);

  const due = world({
    user: ownerUser,
    requests: [{ id: 'req9', user_id: OWNER, kind: 'company', purge_after: '2020-01-01T00:00:00.000Z', cancelled_at: null, completed_at: null, baseline_sign_in_at: '2026-10-01T00:00:00.000Z' }],
    rpcResult: { data: { cancelled: true, reason: 'signed_in' }, error: null },
  });
  const cron = await CRON(new Request('http://x/api/cron/account-deletion', { headers: { authorization: 'Bearer s3cret' } }), { deps: { ...due.deps, env: { CRON_SECRET: 's3cret' } } });
  assert.equal(cron.status, 200);
  assert.equal((await cron.json()).results[0].cancelled, true);
  assert.equal(due.calls.deleted.length, 0);
  assert.equal(due.deps.admin.db.account_deletion_requests[0].completed_at ?? null, null);
  assert.match(read('app/components/DangerZone.js'), /data-testid="deletion-blocked"/);
});

test('signing in again cancels a pending company deletion; an explicit cancel does too', async () => {
  const pending = {
    id: 'req1', user_id: OWNER, kind: 'company', purge_after: '2026-11-11T00:00:00.000Z',
    baseline_sign_in_at: '2026-10-20T00:00:00.000Z', cancelled_at: null, completed_at: null, applied_at: null,
  };
  const same = world({
    user: { id: OWNER, email: 'owner@example.test', last_sign_in_at: '2026-10-20T00:00:00.000Z' },
    profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: false }],
    requests: [{ ...pending }],
  });
  const stay = await GET(new Request('http://x/api/account/deletion', { headers: { authorization: 'Bearer t' } }), { deps: same.deps });
  const stayBody = await stay.json();
  assert.equal(stayBody.pending.purge_after, pending.purge_after);
  assert.equal(stayBody.cancelled, false);

  const again = world({
    user: { id: OWNER, email: 'owner@example.test', last_sign_in_at: '2026-10-28T12:00:00.000Z' },
    profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: false }],
    requests: [{ ...pending }],
  });
  const cancelled = await GET(new Request('http://x/api/account/deletion', { headers: { authorization: 'Bearer t' } }), { deps: again.deps });
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.cancelled, true);
  assert.equal(cancelledBody.pending, null);
  assert.match(cancelledBody.message, /signed in/);
  assert.ok(again.deps.admin.db.account_deletion_requests[0].cancelled_at);
  assert.equal(again.deps.admin.db.account_deletion_requests[0].cancel_reason, 'signed_in');

  const button = world({
    user: { id: OWNER, email: 'owner@example.test', last_sign_in_at: '2026-10-20T00:00:00.000Z' },
    profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FS Trucks', is_demo: false }],
    requests: [{ ...pending, id: 'req2' }],
  });
  const off = await post({ intent: 'cancel' }, button.deps);
  assert.equal((await off.json()).cancelled, true);
  assert.equal(button.deps.admin.db.account_deletion_requests[0].cancel_reason, 'cancelled');
  assert.equal(button.calls.rpc.length, 0);
});

test('cron route refuses a missing or wrong secret and only then runs due deletions', async () => {
  const open = { id: 'req1', user_id: OWNER, kind: 'company', purge_after: '2020-01-01T00:00:00.000Z', cancelled_at: null, completed_at: null };
  const pending = world({ user: { id: OWNER }, requests: [open], profiles: [] });
  const bare = await CRON(new Request('http://x/api/cron/account-deletion'), { deps: { ...pending.deps, env: {} } });
  assert.equal(bare.status, 503);
  const wrong = await CRON(new Request('http://x/api/cron/account-deletion', { headers: { authorization: 'Bearer nope' } }), { deps: { ...pending.deps, env: { CRON_SECRET: 's3cret' } } });
  assert.equal(wrong.status, 401);
  assert.equal(pending.calls.rpc.length, 0);
  const ok = await CRON(new Request('http://x/api/cron/account-deletion', { headers: { authorization: 'Bearer s3cret' } }), { deps: { ...pending.deps, env: { CRON_SECRET: 's3cret' } } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).finished, 1);
  assert.equal(pending.calls.rpc[0].args.p_user, OWNER);
  assert.ok(pending.deps.admin.db.account_deletion_requests[0].completed_at);
  assert.equal(cronAuthorized('Bearer s3cret', '', { CRON_SECRET: 's3cret' }), true);
  assert.equal(cronAuthorized('Bearer secret', '', { CRON_SECRET: 's3cret' }), false);
});

test('storage cleanup moves company files before it deletes a personal folder', async () => {
  const ops = [];
  const bucket = {
    copy: async (from, to) => { ops.push(['copy', from, to]); return { error: null }; },
    remove: async (paths) => { ops.push(['remove', ...paths]); return { error: null }; },
    list: async (dir) => ({ data: dir === MEMBER ? [{ name: 'bug-reports', id: null, metadata: null }, { name: 'loose.jpg', id: 'f1', metadata: { size: 1 } }] : [{ name: '1.png', id: 'f2', metadata: { size: 2 } }], error: null }),
  };
  const listed = await listStoragePrefix(bucket, MEMBER);
  assert.deepEqual(listed.paths.sort(), [`${MEMBER}/bug-reports/1.png`, `${MEMBER}/loose.jpg`].sort());
  const admin = {
    storage: { from: () => bucket },
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  };
  const plan = {
    jobs: [
      { id: 'j2', op: 'delete_prefix', from_path: MEMBER, to_path: '' },
      { id: 'j1', op: 'move', from_path: `${MEMBER}/bol.pdf`, to_path: `${OWNER}/retained/${MEMBER}/bol.pdf` },
    ],
  };
  const ran = await applyStoragePlan(admin, plan);
  assert.equal(ran.ok, true);
  assert.deepEqual(ops[0], ['copy', `${MEMBER}/bol.pdf`, `${OWNER}/retained/${MEMBER}/bol.pdf`]);
  assert.equal(ops[1][0], 'remove');
  assert.ok(ops[1].includes(`${MEMBER}/bug-reports/1.png`));
});
