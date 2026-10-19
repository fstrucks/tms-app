// Owner-only member-role editor: lib, route (mocked Supabase; the real checks live in set_member_role, see
// tests/sql/member_role_editor.pglite.mjs) and page wiring. FAKE data only; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POST, GET } from '../../app/api/account/invites/route.js';
import { EDITABLE_ROLES, ROLE_HELP, roleEditable, validateRoleChange, roleError, setMemberRole, confirmText, successText } from '../../app/lib/memberRoles.js';

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
const okRpc = (fn, a) => (fn === 'member_assigned_load_count' ? { data: 3, error: null } : { data: [{ user_id: a.p_user, old_role: 'driver', new_role: a.p_role, unassigned_loads: a.p_role === 'driver' ? 0 : 2 }], error: null });

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
  assert.deepEqual(r, { ok: true, previous: 'driver', role: 'management', unassigned: 2 });
  assert.equal((await setMemberRole({ rpc: async () => ({ data: [], error: null }) }, DRV, 'driver')).status, 500, 'no row back = not confirmed');
  assert.equal((await setMemberRole({ rpc: async () => { throw new Error('network'); } }, DRV, 'driver')).status, 500);
});

test('route: owner changes a role; the RPC runs with the caller token client, not the service client', async () => {
  const r = await call({ action: 'role', user_id: DRV, role: 'dispatcher' }, OWNER, okRpc);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j, { ok: true, user_id: DRV, role: 'dispatcher', previous: 'driver', unassigned: 2 });
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
  assert.match(page, /data-testid="role-save"[^>]*disabled=\{!!busy \|\| roleEdit\.role === x\.role\} onClick=\{\(\) => askRole\(x\)\}/, 'Save only opens the confirmation (after counting loads)');
  assert.match(page, /data-testid="role-confirm-yes"[^>]*onClick=\{\(\) => saveRole\(x\)\}/, 'only the confirmation saves');
  assert.match(page, /action: 'role', user_id: x\.id, role: roleEdit\.role/);
  assert.match(page, /data-testid="role-msg" data-kind=\{roleMsg\.ok \? 'ok' : 'error'\}/);
  assert.match(page, /EDITABLE_ROLES\.map/);
  assert.doesNotMatch(page, /set_member_role|from\('company_members'\)/, 'page never writes members itself');
});

// ---------- Review fixes (Taylor): unassign on driver → other role, clear messages, strict input ----------
import { unassignsLoads, unassignWarning, memberAssignedCount, validateMemberId, NOT_OWNER_ROLE_TEXT } from '../../app/lib/memberRoles.js';
import { DRIVER_GONE_TEXT, saveDriverSettings } from '../../app/lib/loadDriver.js';
import { createManualLoad } from '../../app/lib/loadNew.js';

test('non-string / array user_id or role → 422 (no "[uuid]" stringifying into a valid id)', async () => {
  for (const b of [{ user_id: [DRV], role: 'driver' }, { user_id: DRV, role: ['driver'] }, { user_id: { id: DRV }, role: 'driver' }, { user_id: 123, role: 'driver' },
    { user_id: DRV, role: 1 }, { user_id: DRV, role: true }, [DRV, 'driver'], null, 'x']) assert.equal(validateRoleChange(b).status, 422, JSON.stringify(b));
  assert.equal(validateMemberId({ user_id: [DRV] }).status, 422);
  assert.deepEqual(validateMemberId({ user_id: DRV }), { userId: DRV });
  const r = await call({ action: 'role', user_id: [DRV], role: 'dispatcher' }, OWNER, okRpc);
  assert.equal(r.status, 422); assert.equal(r.calls.length, 0);
  assert.equal((await call({ action: 'role', user_id: DRV, role: ['management'] }, OWNER, okRpc)).status, 422);
  assert.equal((await call({ action: 'role_preview', user_id: [DRV] }, OWNER, okRpc)).status, 422);
});

test('non-owner trying to change a role gets role text, not the invite text', async () => {
  for (const action of ['role', 'role_preview']) {
    const r = await call({ action, user_id: DRV, role: 'management' }, DISP, okRpc);
    assert.equal(r.status, 403); assert.equal(r.j.error, NOT_OWNER_ROLE_TEXT); assert.equal(r.calls.length, 0);
  }
  const inv = await call({ email: 'x@example.com' }, DISP, okRpc);
  assert.match(inv.j.error, /invite/, 'the invite form keeps its own text');
});

test('confirmation: count of assigned loads, only when a driver moves away from Driver', async () => {
  assert.equal(unassignsLoads('driver', 'dispatcher'), true); assert.equal(unassignsLoads('driver', 'management'), true);
  assert.equal(unassignsLoads('dispatcher', 'driver'), false); assert.equal(unassignsLoads('management', 'dispatcher'), false);
  assert.equal(unassignWarning('Pat (FAKE)', 2), 'Pat (FAKE) is assigned to 2 loads. Changing their role unassigns them.');
  assert.equal(unassignWarning('Pat (FAKE)', 1), 'Pat (FAKE) is assigned to 1 load. Changing their role unassigns them.');
  assert.equal(unassignWarning('Pat (FAKE)', 0), null);
  const p = await call({ action: 'role_preview', user_id: DRV }, OWNER, okRpc);
  assert.equal(p.status, 200); assert.deepEqual(p.j, { ok: true, user_id: DRV, assigned: 3 });
  assert.deepEqual(p.calls, [{ fn: 'member_assigned_load_count', args: { p_user: DRV } }]);
  assert.equal((await memberAssignedCount({ rpc: async () => ({ data: null, error: { message: 'not_member' } }) }, DRV)).status, 404);
  assert.match(successText('Pat (FAKE)', 'dispatcher', 2), /Unassigned from 2 loads; pick a new driver on them\./);
  assert.doesNotMatch(successText('Pat (FAKE)', 'dispatcher', 0), /Unassigned/);
});

test('assigned_driver_not_driver → one clear message everywhere it can surface', async () => {
  assert.equal(DRIVER_GONE_TEXT, 'This load’s driver is no longer a driver. Pick a new one.');
  const e = { message: 'assigned_driver_not_driver', code: 'P0001' };
  assert.deepEqual(roleError(e), { error: DRIVER_GONE_TEXT, status: 409, code: 'assigned_driver_not_driver' });
  const sd = await saveDriverSettings({ rpc: async () => ({ data: null, error: e }) }, 'L1', DRV, true);
  assert.equal(sd.error, DRIVER_GONE_TEXT);
  const nl = await createManualLoad({ from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: e }) }) }) }) }, { load: {}, stops: [] });
  assert.equal(nl.error, DRIVER_GONE_TEXT);
  const route = await call({ action: 'role', user_id: DRV, role: 'dispatcher' }, OWNER, () => ({ data: null, error: e }));
  assert.equal(route.status, 409); assert.equal(route.j.error, DRIVER_GONE_TEXT);
});

test('page: Save role counts loads first; the warning shows in the confirmation; success says how many were unassigned', () => {
  const page = readFileSync('app/account/invite/page.js', 'utf8');
  assert.match(page, /if \(!unassignsLoads\(x\.role, roleEdit\.role\)\) return setRoleEdit\(\{ \.\.\.roleEdit, confirm: true, assigned: 0 \}\);/);
  assert.match(page, /action: 'role_preview', user_id: x\.id/);
  assert.match(page, /data-testid="role-unassign-warning"/);
  assert.match(page, /unassignWarning\(x\.name \|\| x\.email, roleEdit\.assigned\)/);
  assert.match(page, /successText\(x\.name \|\| x\.email, r\.role, r\.unassigned\)/);
});

test('migration 0800: unassigns on driver → other role, returns the count, count function owner-only', () => {
  const mig = readFileSync('supabase/migrations/20261018000800_member_role_editor.sql', 'utf8');
  assert.match(mig, /if v_old = 'driver' and p_role <> 'driver' then\s*update public\.loads l set assigned_driver_user_id = null, show_rate_to_driver = false\s*where l\.user_id = v_profile\.owner_id and l\.assigned_driver_user_id = p_user;/);
  assert.match(mig, /returns table \(user_id uuid, old_role text, new_role text, unassigned_loads integer\)/);
  assert.match(mig, /revoke all on function public\.member_assigned_load_count\(uuid\) from public, anon;/);
  assert.doesNotMatch(mig, /create policy|drop policy|alter table|grant (select|insert|update|delete)/i);
});

test('role descriptions: Dispatcher mentions the dispatch center; the editor uses theme tokens only', () => {
  assert.equal(ROLE_HELP.dispatcher, 'Dispatcher: can manage loads, stops and drivers in Dispatch, plus packets and the company profile.');
  assert.match(ROLE_HELP.management, /^Management: same as Dispatcher/);
  const page = readFileSync('app/account/invite/page.js', 'utf8');
  assert.doesNotMatch(page, /#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?\b|rgba?\(/, 'no hardcoded colors (dark mode #95)');
  assert.match(page, /data-testid="role-editor" style=\{\{ background: 'var\(--surface-2\)', border: '1px solid var\(--divider\)'/);
  assert.match(page, /data-testid="role-unassign-warning" style=\{\{[^}]*color: 'var\(--warning\)', background: 'var\(--warning-bg\)'/);
});
