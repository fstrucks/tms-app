// QA #103 follow-ups: active company (switcher), dates on Team rows, welcome vs Join card. FAKE data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveActive, pickProfile, readActiveCookie, activeCookieString, ACTIVE_COOKIE } from '../../app/lib/activeCompany.js';
import { viewingFor } from '../../app/lib/activeCompanyView.js';
import { joinedText } from '../../app/lib/companyAdds.js';
import { inviteRows } from '../../app/lib/testerInvites.js';
import { GET, POST } from '../../app/api/account/active-company/route.js';
import { BUSY_UI_SELECTOR } from '../../app/lib/welcome.js';

const U = 'user-av', A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', OWN = 'ffffffff-0000-4000-8000-000000000003';
const cA = { profile_id: A, owner_id: 'own-a', role: 'dispatcher', name: 'Test Trucking Co', joined_at: '2026-10-01T00:00:00Z' };
const cB = { profile_id: B, owner_id: 'own-b', role: 'management', name: 'Fake Haulers LLC', joined_at: '2026-10-19T20:00:00Z' };
const cOwn = { profile_id: OWN, owner_id: U, role: 'owner', name: 'Mine', joined_at: '2026-09-01T00:00:00Z' };

test('resolveActive: valid choice wins; otherwise owned; otherwise most recent join; forged choice ignored', () => {
  assert.equal(resolveActive([cA, cB], U, A).profile_id, A);
  assert.equal(resolveActive([cA, cB], U, null).profile_id, B);
  assert.equal(resolveActive([cA, cB, cOwn], U, null).profile_id, OWN);
  assert.equal(resolveActive([cA, cB], U, 'prof-not-mine').profile_id, B);
  assert.equal(resolveActive([], U, A), null);
});

test('cookie: HttpOnly, Path=/, parsed back; junk rejected', () => {
  const c = activeCookieString(B);
  assert.match(c, /HttpOnly/); assert.match(c, /Path=\//); assert.match(c, /Secure/);
  assert.equal(readActiveCookie(fakeReq({ cookie: `a=1; ${ACTIVE_COOKIE}=${B}` })), B);
  assert.equal(readActiveCookie(fakeReq({ cookie: `${ACTIVE_COOKIE}=<script>` })), null);
});

test('pickProfile (company profile page): uses the active company only if the caller is a member', () => {
  const profiles = [{ id: A, owner_id: 'own-a' }, { id: B, owner_id: 'own-b' }];
  const members = [{ profile_id: A, user_id: U, role: 'dispatcher', created_at: cA.joined_at }, { profile_id: B, user_id: U, role: 'management', created_at: cB.joined_at }];
  assert.equal(pickProfile(profiles, members, U, A).id, A);
  assert.equal(pickProfile(profiles, members, U, null).id, B);
  assert.equal(pickProfile(profiles, members.slice(0, 1), U, B).id, A); // not a member of B → not picked
});

test('viewingFor (/loads): only for multi-company users with another company active; drivers pointed Home', () => {
  assert.equal(viewingFor({ multi: false, active: cB }, U), null);
  assert.equal(viewingFor({ multi: true, active: cOwn }, U), null);
  const v = viewingFor({ multi: true, active: cB }, U);
  assert.equal(v.kind, 'company'); assert.equal(v.owner_id, 'own-b'); assert.equal(v.href, '/dispatch');
  assert.equal(viewingFor({ multi: true, active: { ...cA, role: 'driver' } }, U).href, '/');
});

test('Join text matches what happens next', () => {
  const a = { company: B, company_name: 'Fake Haulers LLC', role: 'management' };
  assert.match(joinedText(a, { active: cB }), /working in it now/);
  assert.match(joinedText(a, { active: cOwn }), /still working in Mine.*Switch now/);
  assert.doesNotMatch(joinedText(a, { active: cB }), /Reload/);
});

function sb(mems, profiles) {
  const from = (name) => { const f = []; const run = (one) => { const rows = (name === 'company_members' ? mems : profiles).filter((r) => f.every(([k, v]) => r[k] === v)); return { data: one ? rows[0] || null : rows, error: null }; };
    const b = { select: () => b, eq: (k, v) => { f.push([k, v]); return b; }, maybeSingle: async () => run(true), then: (res, rej) => Promise.resolve(run(false)).then(res, rej) }; return b; };
  return { from, auth: { admin: {} } };
}
const uc = (id) => () => ({ auth: { getUser: async () => ({ data: { user: { id } }, error: null }) } });
// Plain request object: fetch's Request drops the Cookie header (forbidden header), Next's request keeps it.
const fakeReq = (h, body) => ({ url: 'https://x/api/account/active-company', headers: { get: (k) => h[k.toLowerCase()] ?? null }, json: async () => body });
const rq = (body, cookie = '') => fakeReq({ authorization: 'Bearer t', cookie }, body);

test('active-company route: lists my companies, honours a valid cookie, refuses a company I’m not in', async () => {
  const s = sb([{ profile_id: A, user_id: U, role: 'dispatcher', created_at: cA.joined_at }, { profile_id: B, user_id: U, role: 'management', created_at: cB.joined_at }],
    [{ id: A, owner_id: 'own-a', legal_name: 'Test Trucking Co' }, { id: B, owner_id: 'own-b', legal_name: 'Fake Haulers LLC' }, { id: 'cccccccc-0000-4000-8000-000000000004', owner_id: 'own-c', legal_name: 'Other' }]);
  const deps = { sb: s, mkUserClient: uc(U) };
  const g = await (await GET(rq(null), { deps })).json();
  assert.equal(g.companies.length, 2); assert.equal(g.active.profile_id, B);
  assert.equal((await (await GET(rq(null, `${ACTIVE_COOKIE}=${A}`), { deps })).json()).active.profile_id, A);
  const bad = await POST(rq({ profile_id: 'cccccccc-0000-4000-8000-000000000004' }), { deps }); assert.equal(bad.status, 403); assert.equal(bad.headers.get('set-cookie'), null);
  const ok = await POST(rq({ profile_id: A }), { deps }); assert.equal(ok.status, 200); assert.match(ok.headers.get('set-cookie'), new RegExp(`${ACTIVE_COOKIE}=${A}`));
});

test('Team rows: pending add shows its own time; direct add shows "added"; this company’s invite keeps invited', () => {
  const profile = { id: B, owner_id: 'own-b' };
  const users = [
    { id: 're', email: 're@fstrucks.com', invited_at: '2026-10-05T00:00:00Z', email_confirmed_at: '2026-10-05T01:00:00Z', app_metadata: { tester_invite: { company: A }, pending_company_adds: { [B]: { by: 'own-b', role: 'driver', at: '2026-10-19T21:00:00Z' } } } },
    { id: 'da', email: 'da@fstrucks.com', invited_at: '2026-10-02T00:00:00Z', email_confirmed_at: '2026-10-02T01:00:00Z', app_metadata: { tester_invite: { company: A } } },
    { id: 'iv', email: 'iv@fstrucks.com', invited_at: '2026-10-10T00:00:00Z', app_metadata: { tester_invite: { company: B } } }];
  const rows = inviteRows(users, [{ user_id: 'da', role: 'management', created_at: '2026-10-19T20:30:00Z' }, { user_id: 'iv', role: 'driver', created_at: '2026-10-10T00:00:00Z' }], profile);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.re.added_at, '2026-10-19T21:00:00Z'); assert.equal(by.re.invited_at, null);
  assert.equal(by.da.added_at, '2026-10-19T20:30:00Z'); assert.equal(by.da.invited_at, null);
  assert.equal(by.iv.added_at, null); assert.equal(by.iv.invited_at, '2026-10-10T00:00:00Z');
  const page = readFileSync('app/account/invite/page.js', 'utf8');
  assert.match(page, /x\.added_at \? ` · added \$\{formatSentAt\(x\.added_at\)\}`/);
});

test('welcome sheet waits for the Join check/card and never opens over the role editor or its confirm', () => {
  for (const sel of ['body[data-pending-add]', 'body[data-pending-add-check]', '[role="alertdialog"]', '[data-ui-busy]']) assert.ok(BUSY_UI_SELECTOR.includes(sel), sel);
  assert.match(readFileSync('app/account/invite/page.js', 'utf8'), /data-testid="role-editor" data-ui-busy/);
  const p = readFileSync('app/components/CompanyAddPrompt.js', 'utf8');
  assert.match(p, /dataset\.pendingAddCheck = '1'/); assert.match(p, /dataset\.pendingAdd = '1'/);
});
