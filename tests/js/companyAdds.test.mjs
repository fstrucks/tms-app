// feat/add-existing-member: owner adds someone who already has an account. MOCKED Supabase. FAKE data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as INV, GET as INV_GET } from '../../app/api/account/invites/route.js';
import { GET, POST } from '../../app/api/account/company-adds/route.js';
import { HOURLY_LIMIT } from '../../app/lib/testerInvites.js';

const OWNER = 'owner-0000', PROFILE = 'prof-0001', OTHER_OWNER = 'owner-9999', OTHER = 'prof-9999', T0 = Date.parse('2026-10-19T20:00:00-05:00');
const iso = (ms) => new Date(ms).toISOString();
const acct = (id, email, extra = {}) => ({ id, email, invited_at: null, email_confirmed_at: iso(T0 - 864e5), last_sign_in_at: iso(T0 - 3600e3), user_metadata: {}, app_metadata: {}, ...extra });

function mockSb({ users = [], members = [], profiles = [{ id: PROFILE, owner_id: OWNER, legal_name: 'Fake Haulers LLC' }, { id: OTHER, owner_id: OTHER_OWNER, legal_name: 'Test Trucking Co' }] } = {}) {
  const t = { users: users.map((u) => ({ ...u })), company_members: members.map((m) => ({ ...m })), company_profiles: profiles, invites: [] };
  const admin = {
    listUsers: async ({ page }) => ({ data: { users: page === 1 ? t.users : [] }, error: null }),
    inviteUserByEmail: async (email) => { t.invites.push(email); return { data: null, error: { status: 500 } }; },
    getUserById: async (id) => ({ data: { user: t.users.find((x) => x.id === id) || null }, error: null }),
    updateUserById: async (id, attrs) => { const u = t.users.find((x) => x.id === id); if (u) Object.assign(u, attrs); return { data: { user: u }, error: null }; },
  };
  const from = (name) => {
    const st = { f: [], op: 'select' };
    const run = () => {
      if (st.op === 'insert') { t[name].push({ ...st.payload }); return { data: null, error: null }; }
      const rows = (t[name] || []).filter((r) => st.f.every(([k, v]) => r[k] === v));
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; }, limit() { return b; }, order() { return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) };
    return b;
  };
  return { t, from, auth: { admin } };
}
const uc = (id) => () => ({ auth: { getUser: async () => ({ data: { user: { id, email: `${id}@fstrucks.com`, user_metadata: {} } }, error: null }) } });
const rq = (url, body, method = 'POST') => new Request(`https://x${url}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const inv = async (sb, body, who = OWNER) => { const r = await INV(rq('/api/account/invites', body), { deps: { sb, mkUserClient: uc(who), now: () => T0 } }); return { status: r.status, j: await r.json() }; };
const mine = async (sb, who, body) => { const r = body ? await POST(rq('/api/account/company-adds', body), { deps: { sb, mkUserClient: uc(who) } }) : await GET(rq('/api/account/company-adds', null, 'GET'), { deps: { sb, mkUserClient: uc(who) } }); return { status: r.status, j: await r.json() }; };

test('existing account in no company → added right away with the chosen role; no email sent', async () => {
  const sb = mockSb({ users: [acct(OWNER, 'owner@fstrucks.com'), acct('u-av', 'fake.avery@fstrucks.com')] });
  const r = await inv(sb, { email: 'Fake.Avery@fstrucks.com', role: 'management' });
  assert.equal(r.status, 200); assert.equal(r.j.added, true); assert.equal(r.j.linked, true);
  assert.deepEqual(sb.t.company_members, [{ profile_id: PROFILE, user_id: 'u-av', role: 'management' }]);
  assert.equal(sb.t.invites.length, 0);
  const again = await inv(sb, { email: 'fake.avery@fstrucks.com', role: 'driver' });
  assert.equal(again.status, 409); assert.equal(again.j.code, 'already_member');
  assert.equal(sb.t.company_members[0].role, 'management'); // never changed by a re-add
});

test('existing account already in ANOTHER company → pending add only; not moved; accept adds, other company kept', async () => {
  const sb = mockSb({ users: [acct(OWNER, 'owner@fstrucks.com'), acct('u-t', 'taylor+invite2@fstrucks.com')], members: [{ profile_id: OTHER, user_id: 'u-t', role: 'driver' }] });
  const r = await inv(sb, { email: 'taylor+invite2@fstrucks.com', role: 'dispatcher' });
  assert.equal(r.status, 200); assert.equal(r.j.pending, true); assert.match(r.j.message, /need to accept/);
  assert.equal(sb.t.company_members.length, 1); // nothing written to members yet
  const list = await (await INV_GET(rq('/api/account/invites', null, 'GET'), { deps: { sb, mkUserClient: uc(OWNER), now: () => T0 } })).json();
  assert.equal(list.invites[0].status, 'add_pending'); assert.equal(list.invites[0].role, 'dispatcher');
  assert.equal((await inv(sb, { email: 'taylor+invite2@fstrucks.com' })).j.code, 'already_pending');
  const p = await mine(sb, 'u-t');
  assert.deepEqual(p.j.adds.map((a) => [a.company, a.role, a.company_name]), [[PROFILE, 'dispatcher', 'Fake Haulers LLC']]);
  assert.equal((await mine(sb, 'someone-else', { company: PROFILE, accept: true })).status, 503); // unknown user: no record
  const a = await mine(sb, 'u-t', { company: PROFILE, accept: true });
  assert.equal(a.status, 200); assert.equal(a.j.joined, true);
  assert.deepEqual(sb.t.company_members.map((m) => [m.profile_id, m.role]).sort(), [[PROFILE, 'dispatcher'], [OTHER, 'driver']]);
  assert.deepEqual((await mine(sb, 'u-t')).j.adds, []);
});

test('pending add: decline adds nothing; owner can cancel; an owner of another company also gets a pending add', async () => {
  const sb = mockSb({ users: [acct(OWNER, 'owner@fstrucks.com'), acct(OTHER_OWNER, 'taylor@fstrucks.com')], members: [{ profile_id: OTHER, user_id: OTHER_OWNER, role: 'owner' }] });
  assert.equal((await inv(sb, { email: 'taylor@fstrucks.com', role: 'driver' })).j.pending, true);
  assert.equal((await mine(sb, OTHER_OWNER, { company: PROFILE, accept: false })).j.joined, false);
  assert.equal(sb.t.company_members.length, 1);
  assert.equal((await mine(sb, OTHER_OWNER, { company: PROFILE, accept: true })).status, 404);
  await inv(sb, { email: 'taylor@fstrucks.com' });
  const c = await inv(sb, { action: 'cancel', email: 'taylor@fstrucks.com' });
  assert.equal(c.status, 200); assert.equal(c.j.cancelled, 'taylor@fstrucks.com');
  assert.deepEqual((await mine(sb, OTHER_OWNER)).j.adds, []);
});

test('only the owner can add; self-add refused; adds count toward the hourly limit', async () => {
  const sb = mockSb({ users: [acct(OWNER, 'owner@fstrucks.com', { app_metadata: { invite_sends: Array.from({ length: HOURLY_LIMIT }, (_, i) => iso(T0 - 1000 * (i + 1))) } }), acct('u-x', 'fake.x@fstrucks.com')],
    members: [{ profile_id: PROFILE, user_id: 'disp-1', role: 'dispatcher' }] });
  assert.equal((await inv(sb, { email: 'fake.x@fstrucks.com' }, 'disp-1')).status, 403);
  assert.equal((await inv(sb, { email: 'owner@fstrucks.com' })).j.code, 'self');
  assert.equal((await inv(sb, { email: 'fake.x@fstrucks.com' })).status, 429);
  assert.equal(sb.t.company_members.length, 1);
});

test('accept is refused if the company changed hands or is gone (stale record cleared)', async () => {
  const sb = mockSb({ users: [acct('u-y', 'fake.y@fstrucks.com', { app_metadata: { pending_company_adds: { [PROFILE]: { by: 'not-the-owner', role: 'driver' } } } })] });
  assert.deepEqual((await mine(sb, 'u-y')).j.adds, []);
  assert.equal((await mine(sb, 'u-y', { company: PROFILE, accept: true })).status, 410);
  assert.equal(sb.t.company_members.length, 0);
});
