// Owner-only member-role editor: lib, route (mocked Supabase; the real checks live in set_member_role, see
// tests/sql/member_role_editor.pglite.mjs) and page wiring. FAKE data only; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POST, GET } from '../../app/api/account/invites/route.js';
import { EDITABLE_ROLES, roleEditable, validateRoleChange, roleError, setMemberRole, confirmText, successText } from '../../app/lib/memberRoles.js';

const OWNER = '00000000-0000-4000-8000-00000000000a', DRV = '00000000-0000-4000-8000-00000000000d', DISP = '00000000-0000-4000-8000-00000000000b';
const PROFILE = { id: 'prof-1', owner_id: OWNER, legal_name: 'FAKE Freight LLC' };

function svc({ profiles = [PROFILE] } = {}) {
  return {
    from: (name) => { const f = []; const b = { select: () => b, eq: (k, v) => { f.push([k, v]); return b; }, maybeSingle: async () => ({ data: (name === 'company_profiles' ? profiles : []).find((r) => f.every(([k, v]) => r[k] === v)) || null, error: null }) }; return b; },
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  };
}
// The caller's own-token client. rpc() simulates the database's answer.
function userC(id, rpcImpl) {
  const calls = [];
  return { calls, mk: () => ({ auth: { getUser: async () => ({ data: { user: { id, email: `${id}@example.com` } }, error: null }) },
    rpc: async (fn, args) => { calls.push({ fn, args }); return rpcImpl(fn, args); } }) };
}
const req = (body) => new Request('https://example.test/api/account/invites', { method: 'POST', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (body, who, rpcImpl, sb = svc()) => { const u = userC(who, rpcImpl); const r = await POST(req(body), { deps: { sb, mkUserClient: u.mk } }); return { status: r.status, j: await r.json(), calls: u.calls }; };
const okRpc = (fn, a) => ({ data: [{ user_id: a.p_user, old_role: 'driver', new_role: a.p_role }], error: null });

test('roles offered are exactly Driver, Dispatcher, Management (never owner)', () => {
  assert.deepEqual(EDITABLE_ROLES, ['driver', 'dispatcher', 'management']);
});

test('roleEditable: linked non-owner members only', () => {
  assert.equal(roleEditable({ id: DRV, linked: true, role: 'driver' }, OWNER), true);
  assert.equal(roleEditable({ id: DRV, linked: false, role: 'driver' }, OWNER), false, 'pending / not linked');
  assert.equal(roleEditable({ id: DRV, linked: true, role: 'owner' }, OWNER), false, 'owner-role member');
  assert.equal(roleEditable({ id: OWNER, linked: true, role: 'management' }, OWNER), false, 'the owner themselves');
  assert.equal(roleEditable({ id: DRV, linked: true, role: null }, OWNER), false);
});

test('validateRoleChange rejects bad ids and roles', () => {
  assert.deepEqual(validateRoleChange({ user_id: DRV, role: 'dispatcher' }), { userId: DRV, role: 'dispatcher' });
  assert.equal(validateRoleChange({ user_id: 'nope', role: 'driver' }).status, 422);
  for (const role of ['owner', 'admin', '', null]) assert.equal(validateRoleChange({ user_id: DRV, role }).status, 422, String(role));
});

test('database codes map to clear messages and statuses', () => {
  const m = (message, code) => roleError({ message, code });
  assert.equal(m('not_owner').status, 403); assert.equal(m('not_member').status, 404);
  assert.equal(m('owner_locked').status, 409); assert.equal(m('last_owner').status, 409);
  assert.equal(m('bad_role').status, 422); assert.equal(m('x', 'PGRST202').code, 'setup');
  assert.equal(m('JWT expired', 'PGRST301').status, 401); assert.equal(m('boom').status, 500);
  assert.match(m('boom').error, /Nothing was changed/);
});

test('setMemberRole calls set_member_role with the caller client and confirms the new role', async () => {
  const u = userC(OWNER, okRpc).mk();
  const r = await setMemberRole(u, DRV, 'management');
  assert.deepEqual(r, { ok: true, previous: 'driver', role: 'management' });
  assert.equal((await setMemberRole({ rpc: async () => ({ data: [], error: null }) }, DRV, 'driver')).status, 500, 'no row back = not confirmed');
  assert.equal((await setMemberRole({ rpc: async () => { throw new Error('network'); } }, DRV, 'driver')).status, 500);
});

test('route: owner changes a role; the RPC runs with the caller token client, not the service client', async () => {
  const r = await call({ action: 'role', user_id: DRV, role: 'dispatcher' }, OWNER, okRpc);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j, { ok: true, user_id: DRV, role: 'dispatcher', previous: 'driver' });
  assert.deepEqual(r.calls, [{ fn: 'set_member_role', args: { p_user: DRV, p_role: 'dispatcher' } }]);
});

test('route: non-owners get 403 before any database write; bad input 422; owner self-edit 409', async () => {
  const a = await call({ action: 'role', user_id: DRV, role: 'management' }, DISP, okRpc);
  assert.equal(a.status, 403); assert.equal(a.calls.length, 0);
  assert.equal((await call({ action: 'role', user_id: DRV, role: 'owner' }, OWNER, okRpc)).status, 422);
  assert.equal((await call({ action: 'role', user_id: 'x', role: 'driver' }, OWNER, okRpc)).status, 422);
  const self = await call({ action: 'role', user_id: OWNER, role: 'driver' }, OWNER, okRpc);
  assert.equal(self.status, 409); assert.equal(self.calls.length, 0);
});

test('route: database refusals come back as clear errors', async () => {
  const deny = (message, code) => () => ({ data: null, error: { message, code: code || 'P0001' } });
  const nm = await call({ action: 'role', user_id: DRV, role: 'driver' }, OWNER, deny('not_member'));
  assert.equal(nm.status, 404); assert.match(nm.j.error, /isn’t a member of your company/);
  assert.equal((await call({ action: 'role', user_id: DRV, role: 'driver' }, OWNER, deny('owner_locked'))).status, 409);
  const setup = await call({ action: 'role', user_id: DRV, role: 'driver' }, OWNER, deny('Could not find the function public.set_member_role', 'PGRST202'));
  assert.equal(setup.status, 503); assert.match(setup.j.error, /database update/);
});

test('GET tells the page who the owner is (so the owner row never gets a Change role button)', async () => {
  const u = userC(OWNER, okRpc);
  const r = await GET(new Request('https://example.test/api/account/invites', { headers: { authorization: 'Bearer fake' } }), { deps: { sb: svc(), mkUserClient: u.mk } });
  assert.equal((await r.json()).ownerId, OWNER);
});

test('copy: confirmation names the person and both roles; success is clear', () => {
  assert.match(confirmText('driver.pat@example.com', 'driver', 'dispatcher'), /^Change driver\.pat@example\.com from Driver to Dispatcher\?/);
  assert.match(successText('Pat (FAKE)', 'management'), /^Pat \(FAKE\) is now Management\./);
});

test('page: Change role → editor → confirmation → save; success/error message; only for editable rows', () => {
  const page = readFileSync('app/account/invite/page.js', 'utf8');
  assert.match(page, /confirmCancel !== x\.id && roleEditable\(x, st\.ownerId\) && roleEdit\?\.id !== x\.id && <button type="button" data-testid="role-edit"/);
  assert.match(page, /data-testid="role-save"[^>]*disabled=\{!!busy \|\| roleEdit\.role === x\.role\} onClick=\{\(\) => setRoleEdit\(\{ \.\.\.roleEdit, confirm: true \}\)\}/, 'Save only opens the confirmation');
  assert.match(page, /data-testid="role-confirm-yes"[^>]*onClick=\{\(\) => saveRole\(x\)\}/, 'only the confirmation saves');
  assert.match(page, /action: 'role', user_id: x\.id, role: roleEdit\.role/);
  assert.match(page, /data-testid="role-msg" data-kind=\{roleMsg\.ok \? 'ok' : 'error'\}/);
  assert.match(page, /EDITABLE_ROLES\.map/);
  assert.doesNotMatch(page, /set_member_role|from\('company_members'\)/, 'page never writes members itself');
});
