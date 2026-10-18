// feat/tester-invites: owner-only invites through a MOCKED Supabase admin client. Nothing is sent. FAKE data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GET, POST } from '../../app/api/account/invites/route.js';
import { validateInvite, inviteStatus, inviteRows, rateLimit, recentSends, redirectFor, HOURLY_LIMIT, ensureMembership } from '../../app/lib/testerInvites.js';

const OWNER = 'owner-0000', PROFILE = 'prof-0001', T0 = Date.parse('2026-10-17T19:30:00-07:00');
const iso = (ms) => new Date(ms).toISOString();

function mockSb({ users = [], members = [], profiles = [{ id: PROFILE, owner_id: OWNER, legal_name: 'FST Fake Trucking LLC' }], inviteError = null, memberInsertError = null } = {}) {
  const t = { users: users.map((u) => ({ ...u })), company_members: members.map((m) => ({ ...m })), company_profiles: profiles, invites: [], updates: [] };
  const admin = {
    listUsers: async ({ page }) => ({ data: { users: page === 1 ? t.users : [] }, error: null }),
    inviteUserByEmail: async (email, opts) => {
      t.invites.push({ email, opts });
      if (inviteError) return { data: null, error: inviteError };
      let u = t.users.find((x) => x.email === email);
      if (!u) { u = { id: `user-${t.users.length + 1}`, email, invited_at: iso(T0), user_metadata: opts.data, email_confirmed_at: null, last_sign_in_at: null }; t.users.push(u); }
      else u.invited_at = iso(T0);
      return { data: { user: u }, error: null };
    },
    updateUserById: async (id, attrs) => { t.updates.push({ id, attrs }); const u = t.users.find((x) => x.id === id); if (u) Object.assign(u, attrs); return { data: { user: u }, error: null }; },
  };
  const from = (name) => {
    const st = { f: [], op: 'select' };
    const run = () => {
      if (st.op === 'insert') { if (memberInsertError) return { error: memberInsertError }; t[name].push({ ...st.payload }); return { data: null, error: null }; }
      const rows = (t[name] || []).filter((r) => st.f.every(([k, v]) => r[k] === v));
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) };
    return b;
  };
  return { t, from, auth: { admin } };
}
const uc = (id) => () => ({ auth: { getUser: async () => ({ data: { user: { id, email: `${id}@fstrucks.com` } }, error: null }) } });
const req = (body, method = 'POST', url = 'https://tms-app-git-feat-tester-invites-fst-tms.vercel.app/api/account/invites') => new Request(url, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const call = async (sb, body, who = OWNER, extra = {}) => { const r = await POST(req(body), { deps: { sb, mkUserClient: uc(who), now: () => T0, ...extra } }); return { status: r.status, j: await r.json() }; };

test('owner-only: non-owners (members, strangers) get 403, no token 401; nothing is sent', async () => {
  const sb = mockSb({ members: [{ profile_id: PROFILE, user_id: 'disp-1', role: 'dispatcher' }] });
  assert.equal((await call(sb, { email: 'taylor+invite1@fstrucks.com' }, 'disp-1')).status, 403);
  assert.equal((await call(sb, { email: 'taylor+invite1@fstrucks.com' }, 'stranger')).status, 403);
  assert.match((await call(sb, { email: 'taylor+invite1@fstrucks.com' }, 'stranger')).j.error, /Only the company owner/);
  assert.equal((await GET(req(null, 'GET'), { deps: { sb, mkUserClient: uc('disp-1') } })).status, 403);
  const noTok = await POST(new Request('https://x/api/account/invites', { method: 'POST', body: '{}' }), { deps: { sb, mkUserClient: uc(OWNER) } });
  assert.equal(noTok.status, 401);
  const authDown = () => ({ auth: { getUser: async () => ({ data: null, error: { status: 500, message: 'down' } }) } });
  assert.equal((await POST(req({ email: 'a@fstrucks.com' }), { deps: { sb, mkUserClient: authDown, authRetryMs: 0 } })).status, 503); // admin action: no DB fallback
  assert.equal(sb.t.invites.length, 0);
});

test('invite: calls inviteUserByEmail with redirectTo <site>/account/password + metadata, and links the user to the owner’s company', async () => {
  const sb = mockSb();
  const r = await call(sb, { email: ' Taylor+Invite1@FSTrucks.com ', name: 'Taylor Test (FAKE)', role: 'management' });
  assert.equal(r.status, 200); assert.equal(r.j.linked, true); assert.equal(r.j.email, 'taylor+invite1@fstrucks.com');
  assert.equal(sb.t.invites.length, 1);
  const { email, opts } = sb.t.invites[0];
  assert.equal(email, 'taylor+invite1@fstrucks.com');
  assert.equal(opts.redirectTo, 'https://tms-app-git-feat-tester-invites-fst-tms.vercel.app/account/password');
  assert.deepEqual(opts.data, { full_name: 'Taylor Test (FAKE)' }); // user-editable metadata: display name only
  assert.deepEqual(sb.t.updates[0].attrs.app_metadata.tester_invite, { by: OWNER, company: PROFILE, role: 'management', log: [iso(T0)] }); // trusted record
  assert.deepEqual(sb.t.company_members, [{ profile_id: PROFILE, user_id: 'user-1', role: 'management' }]);
  // default role is driver; owner is never grantable
  const sb2 = mockSb(); await call(sb2, { email: 'taylor+invite2@fstrucks.com' });
  assert.equal(sb2.t.company_members[0].role, 'driver');
  assert.equal((await call(mockSb(), { email: 'x@fstrucks.com', role: 'owner' })).status, 422);
});

test('duplicates: already-registered → clear 409, already-invited pending → 409 "use Resend"; no email either way', async () => {
  const sb = mockSb({ users: [
    { id: 'u-reg', email: 'taylor@fstrucks.com', invited_at: '2026-10-10T00:00:00Z', email_confirmed_at: '2026-10-10T01:00:00Z', last_sign_in_at: '2026-10-17T10:00:00Z', user_metadata: {} },
    { id: 'u-pend', email: 'taylor+invite1@fstrucks.com', invited_at: iso(T0 - 3600e3 * 5), email_confirmed_at: null, last_sign_in_at: null, user_metadata: {}, app_metadata: { tester_invite: { by: OWNER, company: PROFILE, role: 'driver' } } }] });
  const a = await call(sb, { email: 'TAYLOR@fstrucks.com' });
  assert.equal(a.status, 409); assert.equal(a.j.code, 'already_registered'); assert.match(a.j.error, /already has a PowerHaul account/);
  const b = await call(sb, { email: 'taylor+invite1@fstrucks.com' });
  assert.equal(b.status, 409); assert.equal(b.j.code, 'already_invited'); assert.match(b.j.error, /Use Resend/);
  assert.equal(sb.t.invites.length, 0);
  // GoTrue's own duplicate answer (race) is mapped too
  const race = await call(mockSb({ inviteError: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' } }), { email: 'z@fstrucks.com' });
  assert.equal(race.status, 409); assert.equal(race.j.code, 'already_registered');
});

test('resend: pending → re-invites + logs the send; accepted → no email, just (re)links; other company → 404; cooldown', async () => {
  const pend = { id: 'u-pend', email: 'taylor+invite1@fstrucks.com', invited_at: iso(T0 - 3600e3), email_confirmed_at: null, last_sign_in_at: null, user_metadata: {}, app_metadata: { tester_invite: { by: OWNER, company: PROFILE, role: 'dispatcher', log: [iso(T0 - 3600e3)] } } };
  const acc = { id: 'u-acc', email: 'taylor+invite2@fstrucks.com', invited_at: iso(T0 - 7200e3), email_confirmed_at: iso(T0 - 7000e3), last_sign_in_at: iso(T0 - 7000e3), user_metadata: {}, app_metadata: { tester_invite: { by: OWNER, company: PROFILE, role: 'driver' } } };
  const other = { id: 'u-oth', email: 'someone@fstrucks.com', invited_at: iso(T0 - 7200e3), app_metadata: { tester_invite: { company: 'prof-other' } } };
  const sb = mockSb({ users: [pend, acc, other] });
  const r = await call(sb, { action: 'resend', email: 'TAYLOR+invite1@fstrucks.com' });
  assert.equal(r.status, 200); assert.equal(r.j.emailed, true);
  assert.equal(sb.t.invites.length, 1); assert.equal(sb.t.invites[0].email, 'taylor+invite1@fstrucks.com');
  assert.equal(sb.t.updates[0].attrs.app_metadata.tester_invite.log.at(-1), iso(T0));
  assert.deepEqual(sb.t.company_members.find((m) => m.user_id === 'u-pend'), { profile_id: PROFILE, user_id: 'u-pend', role: 'dispatcher' });
  const again = await call(sb, { action: 'resend', email: 'taylor+invite1@fstrucks.com' }); // seconds later
  assert.equal(again.status, 429); assert.equal(sb.t.invites.length, 1);
  const a = await call(sb, { action: 'resend', email: 'taylor+invite2@fstrucks.com' });
  assert.equal(a.status, 200); assert.equal(a.j.emailed, false); assert.match(a.j.message, /already accepted/); assert.equal(sb.t.invites.length, 1);
  assert.ok(sb.t.company_members.some((m) => m.user_id === 'u-acc' && m.role === 'driver')); // linked, no email
  assert.equal((await call(sb, { action: 'resend', email: 'someone@fstrucks.com' })).status, 404);
  assert.equal((await call(sb, { action: 'resend', email: 'nobody@fstrucks.com' })).status, 404);
});

test('membership linking: idempotent, never changes an existing member’s role; link failure after send is a warning, not an error', async () => {
  const sb = mockSb({ members: [{ profile_id: PROFILE, user_id: 'u-x', role: 'management' }] });
  const m = await ensureMembership(sb, { id: PROFILE }, 'u-x', 'driver');
  assert.equal(m.existing, true); assert.equal(sb.t.company_members.length, 1); assert.equal(sb.t.company_members[0].role, 'management');
  const bad = mockSb({ memberInsertError: { code: '42501' } });
  const err = console.error; console.error = () => {};
  try {
    const r = await call(bad, { email: 'taylor+invite3@fstrucks.com' });
    assert.equal(r.status, 200); assert.equal(r.j.linked, false); assert.match(r.j.warning, /adding them to your company failed/);
  } finally { console.error = err; }
});

test('rate limit: 10 sends per owner per hour (from invite_log), counted across invitees', async () => {
  const log = Array.from({ length: HOURLY_LIMIT }, (_, i) => iso(T0 - (i + 1) * 60e3));
  const users = [{ id: 'u1', email: 'a@fstrucks.com', invited_at: log[0], app_metadata: { tester_invite: { by: OWNER, company: PROFILE, log } } }];
  assert.equal(recentSends(users, OWNER, T0), HOURLY_LIMIT);
  assert.equal(rateLimit(users, OWNER, null, T0).status, 429);
  assert.equal(rateLimit(users, OWNER, null, T0 + 3600e3 + 1), null); // an hour later
  const sb = mockSb({ users });
  const r = await call(sb, { email: 'taylor+invite4@fstrucks.com' });
  assert.equal(r.status, 429); assert.equal(sb.t.invites.length, 0);
  const ok = await call(mockSb({ users }), { email: 'taylor+invite4@fstrucks.com' }, OWNER, { now: () => T0 + 3600e3 + 1 });
  assert.equal(ok.status, 200);
});

test('list: pending/accepted derived from invited_at, email_confirmed_at, last_sign_in_at; owner and other companies hidden', async () => {
  const users = [
    { id: OWNER, email: 'marc@fstrucks.com', email_confirmed_at: 'x', last_sign_in_at: 'x', user_metadata: {} },
    { id: 'u-p', email: 'taylor+invite1@fstrucks.com', invited_at: iso(T0), user_metadata: { full_name: 'T (FAKE)' }, app_metadata: { tester_invite: { company: PROFILE, role: 'driver' } } },
    { id: 'u-a', email: 'taylor@fstrucks.com', invited_at: '2026-10-10T00:00:00Z', email_confirmed_at: '2026-10-10T01:00:00Z', last_sign_in_at: '2026-10-17T00:00:00Z', user_metadata: {} },
    { id: 'u-o', email: 'other@fstrucks.com', invited_at: iso(T0), app_metadata: { tester_invite: { company: 'prof-other' } } }];
  const sb = mockSb({ users, members: [{ profile_id: PROFILE, user_id: OWNER, role: 'owner' }, { profile_id: PROFILE, user_id: 'u-a', role: 'management' }] });
  const g = await (await GET(req(null, 'GET'), { deps: { sb, mkUserClient: uc(OWNER), now: () => T0 } })).json();
  assert.deepEqual(g.invites.map((x) => [x.email, x.status, x.role, x.linked]), [['taylor+invite1@fstrucks.com', 'pending', 'driver', false], ['taylor@fstrucks.com', 'accepted', 'management', true]]);
  assert.deepEqual(g.roles, ['driver', 'dispatcher', 'management']);
  assert.equal(inviteStatus({ invited_at: 'x', email_confirmed_at: null }), 'pending');
  assert.equal(inviteStatus({ invited_at: 'x', last_sign_in_at: 'y' }), 'accepted');
  assert.equal(inviteRows(users, [], { id: PROFILE, owner_id: OWNER }).length, 1);
});

test('validation + redirect + UI wiring', () => {
  assert.match(validateInvite({ email: '' }).error, /Enter/); assert.match(validateInvite({ email: 'nope' }).error, /valid/);
  assert.deepEqual(validateInvite({ email: 'A@B.co', name: '  Ann <b>  ' }), { email: 'a@b.co', name: 'Ann b', role: 'driver' });
  assert.equal(redirectFor(new Request('https://tms-app-two-pi.vercel.app/api/account/invites')), 'https://tms-app-two-pi.vercel.app/account/password');
  const page = readFileSync('app/account/invite/page.js', 'utf8');
  assert.match(page, /Invite a tester/); assert.match(page, /'resend'/);
  assert.match(readFileSync('app/company/page.js', 'utf8'), /role === 'owner' && <p[^>]*><a href="\/account\/invite"/);
  const route = readFileSync('app/api/account/invites/route.js', 'utf8');
  assert.doesNotMatch(route, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/); // goes through the existing serviceClient()
});

test('security: a user who writes invited_company into their own user_metadata is not listed or linkable', async () => {
  const sneaky = { id: 'u-s', email: 'sneaky@fstrucks.com', email_confirmed_at: 'x', last_sign_in_at: 'x', user_metadata: { invited_company: PROFILE, tester_invite: { company: PROFILE } } };
  const sb = mockSb({ users: [sneaky] });
  const g = await (await GET(req(null, 'GET'), { deps: { sb, mkUserClient: uc(OWNER), now: () => T0 } })).json();
  assert.equal(g.invites.length, 0);
  assert.equal((await call(sb, { action: 'resend', email: 'sneaky@fstrucks.com' })).status, 404);
  assert.equal(sb.t.company_members.length, 0);
});
