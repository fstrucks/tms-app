// Role-change unassign sends a dispatched load back to booked (migration 20261025000100).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const PREV = read('supabase/migrations/20261020000100_member_also_drives.sql');
const NEXT = read('supabase/migrations/20261025000100_role_change_unassign_reverts_dispatched.sql');
const CHECK = read('supabase/one-off/20261025_role_change_unassign_status_check.sql');

const OLD_UPDATE = `    update public.loads l set assigned_driver_user_id = null, show_rate_to_driver = false
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;`;
const NEW_UPDATE = `    update public.loads l
       set assigned_driver_user_id = null,
           show_rate_to_driver = false,
           status = case when l.status = 'dispatched' then 'booked' else l.status end
     where l.user_id = v_profile.owner_id and l.assigned_driver_user_id = p_user;`;

function fnSlice(sql, name) {
  const marker = `function public.${name}`;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, marker);
  const end = sql.indexOf('end $$;', start);
  assert.ok(end > start, name);
  return sql.slice(start, end + 'end $$;'.length);
}

const code = (sql) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

test('each function body matches 20261020000100 except the unassign status assignment', () => {
  for (const name of ['set_member_role', 'set_member_also_drives']) {
    const prev = fnSlice(PREV, name);
    const next = fnSlice(NEXT, name);
    assert.equal(prev.split(OLD_UPDATE).length - 1, 1, `${name} previous update`);
    assert.equal(next, prev.replace(OLD_UPDATE, NEW_UPDATE));
    assert.match(next, /language plpgsql security definer set search_path = public/);
    assert.match(next, /get diagnostics v_count = row_count;/);
  }
});

test('migration replaces both functions in place and does not touch tables or policies', () => {
  assert.match(NEXT, /create or replace function public\.set_member_role\(p_user uuid, p_role text, p_also_drives boolean default null\)/);
  assert.match(NEXT, /returns table \(user_id uuid, old_role text, new_role text, unassigned_loads integer, also_drives boolean\)/);
  assert.match(NEXT, /revoke all on function public\.set_member_role\(uuid, text, boolean\) from public, anon;/);
  assert.match(NEXT, /grant execute on function public\.set_member_role\(uuid, text, boolean\) to authenticated;/);
  assert.match(NEXT, /create or replace function public\.set_member_also_drives\(p_user uuid, p_on boolean\)/);
  assert.match(NEXT, /returns table \(user_id uuid, also_drives boolean, unassigned_loads integer\)/);
  assert.match(NEXT, /revoke all on function public\.set_member_also_drives\(uuid, boolean\) from public, anon;/);
  assert.match(NEXT, /grant execute on function public\.set_member_also_drives\(uuid, boolean\) to authenticated;/);
  assert.equal(code(NEXT).split(NEW_UPDATE).length - 1, 2);
  assert.match(code(NEXT), /if \(v_old = 'driver' or v_old_also\) and not \(p_role = 'driver' or v_new_also\) then/);
  assert.match(code(NEXT), /if not coalesce\(p_on, false\) then/);
  assert.doesNotMatch(code(NEXT), /drop function/i);
  assert.doesNotMatch(code(NEXT), /create policy|drop policy|alter table|grant (select|insert|update|delete)/i);
  assert.equal((code(NEXT).match(/update public\.loads l/g) || []).length, 2);
});

test('verification file is read-only and checks both function bodies plus driverless dispatched loads', () => {
  const sql = code(CHECK);
  assert.match(sql, /pg_get_functiondef\(p\.oid\)/);
  assert.match(sql, /status = case when l\.status = ''dispatched'' then ''booked'' else l\.status end/);
  assert.match(sql, /show_rate_to_driver = false/);
  assert.match(sql, /p\.proname in \('set_member_role', 'set_member_also_drives'\)/);
  assert.match(sql, /p\.prosecdef as security_definer/);
  assert.match(sql, /count\(\*\)::integer as dispatched_with_no_driver/);
  assert.match(sql, /where status = 'dispatched'\s+and assigned_driver_user_id is null/);
  assert.match(sql, /where l\.status = 'dispatched'\s+and l\.assigned_driver_user_id is null/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|do)\b/i);
});
