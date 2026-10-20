// "Also drives" flag (Marc picked option A, Oct 20 2026). Migration 20261020000100 (NOT applied).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unassignsLoads, drives, alsoDrivesEditable, validateAlsoDrives, validateRoleChange, setMemberRole, setMemberAlsoDrives, applyAlsoDrives, applyRoleResult, alsoDrivesText } from '../../app/lib/memberRoles.js';
import { inviteRows } from '../../app/lib/testerInvites.js';
import { homeLoadsFor, alsoDrives, fetchMyMemberRows } from '../../app/lib/homeCurrentLoad.js';

const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/20261020000100_member_also_drives.sql');
const U = '11111111-1111-4111-8111-111111111111';

test('migration: column, check, and every driver check is role driver OR also_drives', () => {
  assert.match(MIG, /add column if not exists also_drives boolean not null default false/);
  assert.match(MIG, /check \(not also_drives or role in \('management', 'dispatcher'\)\)/);
  assert.equal((MIG.match(/m\.role = 'driver' or m\.also_drives/g) || []).length, 3); // trigger, choices, create_load
  assert.match(MIG, /v_driver <> v_profile\.owner_id and not exists/); // owner on /dispatch/new
  assert.doesNotMatch(MIG, /create policy|drop policy|grant (select|insert|update|delete)/i);
  assert.match(MIG, /create or replace function public\.set_member_also_drives\(p_user uuid, p_on boolean\)/);
  assert.match(MIG, /if v_role = 'driver' then raise exception 'already_driver'/);
  assert.match(MIG, /v_new_also := case when p_role = 'driver' then false else coalesce\(p_also_drives, v_old_also, false\) end;/);
  assert.match(MIG, /if \(v_old = 'driver' or v_old_also\) and not \(p_role = 'driver' or v_new_also\) then/);
  assert.match(MIG, /grant execute on function public\.set_member_also_drives\(uuid, boolean\) to authenticated;/);
  assert.match(MIG, /revoke all on function public\.set_member_also_drives\(uuid, boolean\) from public, anon;/);
  assert.match(MIG, /drop function if exists public\.set_member_role\(uuid, text\);/);
});

test('unassign only when the person stops driving entirely', () => {
  assert.equal(unassignsLoads('driver', 'management'), true);
  assert.equal(unassignsLoads('driver', 'management', false, true), false); // kept with Also drives
  assert.equal(unassignsLoads('management', 'dispatcher', true, true), false);
  assert.equal(unassignsLoads('management', 'dispatcher', true, false), true);
  assert.equal(unassignsLoads('dispatcher', 'driver', false, false), false);
  assert.equal(drives('management', true), true); assert.equal(drives('driver', false), true); assert.equal(drives('dispatcher', false), false);
});

test('toggle only for linked Dispatcher / Management members, never the owner', () => {
  assert.equal(alsoDrivesEditable({ id: U, linked: true, role: 'management' }, 'o'), true);
  assert.equal(alsoDrivesEditable({ id: U, linked: true, role: 'dispatcher' }, 'o'), true);
  assert.equal(alsoDrivesEditable({ id: U, linked: true, role: 'driver' }, 'o'), false);
  assert.equal(alsoDrivesEditable({ id: U, linked: false, role: 'management' }, 'o'), false);
  assert.equal(alsoDrivesEditable({ id: 'o', linked: true, role: 'management' }, 'o'), false);
  assert.deepEqual(validateAlsoDrives({ user_id: U, on: true }), { userId: U, on: true });
  assert.equal(validateAlsoDrives({ user_id: U, on: 'yes' }).status, 422);
  assert.deepEqual(validateRoleChange({ user_id: U, role: 'management', also_drives: true }), { userId: U, role: 'management', alsoDrives: true });
  assert.deepEqual(validateRoleChange({ user_id: U, role: 'management' }), { userId: U, role: 'management' });
  assert.equal(validateRoleChange({ user_id: U, role: 'management', also_drives: 'x' }).status, 422);
});

const rpcClient = (data, error = null) => { const calls = []; return { calls, rpc: (n, a) => { calls.push([n, a]); return Promise.resolve({ data, error }); } }; };

test('RPC helpers: p_also_drives only when given; toggle maps errors', async () => {
  let c = rpcClient([{ old_role: 'driver', new_role: 'management', unassigned_loads: 0, also_drives: true }]);
  assert.deepEqual(await setMemberRole(c, U, 'management', true), { ok: true, previous: 'driver', role: 'management', unassigned: 0, alsoDrives: true });
  assert.deepEqual(c.calls[0], ['set_member_role', { p_user: U, p_role: 'management', p_also_drives: true }]);
  c = rpcClient([{ old_role: 'driver', new_role: 'dispatcher', unassigned_loads: 2 }]);
  await setMemberRole(c, U, 'dispatcher');
  assert.deepEqual(c.calls[0][1], { p_user: U, p_role: 'dispatcher' }); // old 0800 function still works
  c = rpcClient([{ also_drives: false, unassigned_loads: 3 }]);
  assert.deepEqual(await setMemberAlsoDrives(c, U, false), { ok: true, on: false, unassigned: 3 });
  assert.deepEqual(c.calls[0], ['set_member_also_drives', { p_user: U, p_on: false }]);
  assert.equal((await setMemberAlsoDrives(rpcClient(null, { message: 'already_driver' }), U, true)).status, 409);
  assert.equal((await setMemberAlsoDrives(rpcClient(null, { message: 'not_owner' }), U, true)).status, 403);
  assert.equal((await setMemberAlsoDrives(rpcClient(null, { code: 'PGRST202', message: 'Could not find the function public.set_member_also_drives' }), U, true)).code, 'setup');
  assert.equal(alsoDrivesText('Avery', false, 2), 'Avery no longer drives. Unassigned from 2 loads; pick a new driver on them.');
});

test('Team list carries also_drives; row updates', () => {
  const rows = inviteRows([{ id: U, email: 'a@test.invalid' }], [{ user_id: U, role: 'management', also_drives: true }], { id: 'p', owner_id: 'o' });
  assert.equal(rows[0].also_drives, true);
  assert.equal(applyAlsoDrives(rows, U, false)[0].also_drives, false);
  assert.equal(applyRoleResult(rows, U, 'dispatcher', true)[0].also_drives, true);
  const page = read('app/account/invite/page.js');
  assert.match(page, /data-testid="also-drives-toggle"/); assert.match(page, /data-testid="role-also-drives"/);
  assert.match(page, /st\.alsoDrives && confirmCancel !== x\.id && alsoDrivesEditable\(x, st\.ownerId\)/);
  const route = read('app/api/account/invites/route.js');
  assert.match(route, /b\?\.action === 'also_drives'/); assert.match(route, /setMemberAlsoDrives\(c\.uc, v\.userId, v\.on\)/);
});

test('Home: an also-driver member sees only his assigned loads; others unchanged', async () => {
  const loads = [{ id: 'a', assigned_driver_user_id: U }, { id: 'b', assigned_driver_user_id: 'x' }, { id: 'c', assigned_driver_user_id: null }];
  const also = [{ user_id: U, role: 'management', also_drives: true }];
  assert.deepEqual(homeLoadsFor(loads, U, also, 'member').map((l) => l.id), ['a']);
  assert.equal(homeLoadsFor(loads, U, [{ user_id: U, role: 'management' }], 'member'), loads);
  assert.equal(homeLoadsFor(loads, U, also, 'owner'), loads);
  assert.equal(alsoDrives(U, also), true);
  // before the migration: the also_drives column is missing → retry without it
  const calls = [];
  const sb = { from: () => ({ select: (cols) => ({ eq: () => { calls.push(cols); return Promise.resolve(cols.includes('also_drives') ? { data: null, error: { code: '42703', message: 'column company_members.also_drives does not exist' } } : { data: [{ user_id: U, role: 'management' }], error: null }); } }) }) };
  const m = await fetchMyMemberRows(sb, U);
  assert.deepEqual(calls, ['user_id, role, also_drives', 'user_id, role']); assert.equal(m.error, null);
});
