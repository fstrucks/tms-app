// Owner-only member-role editor (Team list on /account/invite). The database decides: public.set_member_role
// (migration 20261018000800) runs as the caller, checks they own the company, that the person is a member of THAT
// company, isn't the owner, and that the role is Driver / Dispatcher / Management. This file only shapes the request
// and turns the database's answer into plain messages.
import { ROLE_LABELS } from './companyRoles.js';
import { DRIVER_GONE_TEXT } from './loadDriver.js';

export const EDITABLE_ROLES = ['driver', 'dispatcher', 'management']; // never 'owner'
export const ROLE_HELP = {
  driver: 'Driver: view and upload.',
  dispatcher: 'Dispatcher: can manage loads, stops and drivers in Dispatch, plus packets and the company profile.',
  management: 'Management: same as Dispatcher, plus the W-9, MC Authority and NOA in Company Documents.',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = (r) => ROLE_LABELS[r] || r;

// Can this Team row's role be changed here? Only linked members who aren't the owner.
export const roleEditable = (row, ownerId) => !!row && row.linked === true && row.role !== 'owner' && row.id !== ownerId && EDITABLE_ROLES.includes(row.role);

// → { userId, role } | { error, status }. Only plain strings: an array like ["<uuid>"] would otherwise stringify to a
// valid-looking id.
export function validateRoleChange(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Bad request.', status: 422 };
  if (typeof b.user_id !== 'string' || !UUID.test(b.user_id.trim())) return { error: 'Which person? Pick someone from the list.', status: 422 };
  if (typeof b.role !== 'string' || !EDITABLE_ROLES.includes(b.role.trim())) return { error: 'Pick Driver, Dispatcher or Management.', status: 422 };
  if (b.also_drives != null && typeof b.also_drives !== 'boolean') return { error: 'Bad request.', status: 422 };
  return { userId: b.user_id.trim(), role: b.role.trim(), ...(typeof b.also_drives === 'boolean' ? { alsoDrives: b.also_drives } : {}) };
}
// "Also drives" toggle (20261020000100). → { userId, on } | { error, status }
export function validateAlsoDrives(b) {
  const v = validateMemberId(b);
  if (v.error) return v;
  if (typeof b.on !== 'boolean') return { error: 'Bad request.', status: 422 };
  return { userId: v.userId, on: b.on };
}
// Only Dispatcher / Management members can also drive (a Driver already drives; the owner is offered as "Me").
export const ALSO_DRIVES_ROLES = ['dispatcher', 'management'];
export const alsoDrivesEditable = (row, ownerId) => roleEditable(row, ownerId) && ALSO_DRIVES_ROLES.includes(row.role);
export const ALSO_DRIVES_HELP = 'Also drives: they can be picked as a load’s driver, and Home shows the loads assigned to them. Their role’s other access doesn’t change.';
export const alsoDrivesText = (who, on, unassigned = 0) => (on ? `${who} can now be assigned as a driver.` : `${who} no longer drives.${unassigned > 0 ? ` Unassigned from ${loadsWord(unassigned)}; pick a new driver on ${unassigned === 1 ? 'it' : 'them'}.` : ''}`);
// Same id check for the "how many loads" lookup. → { userId } | { error, status }
export function validateMemberId(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.user_id !== 'string' || !UUID.test(b.user_id.trim())) return { error: 'Which person? Pick someone from the list.', status: 422 };
  return { userId: b.user_id.trim() };
}

// Moving a driver to another role unassigns them from the company's loads (set_member_role does it in the database).
// With "Also drives" (20261020000100): only when the person stops driving entirely (driver/also-driver → neither).
export const drives = (role, also) => role === 'driver' || (ALSO_DRIVES_ROLES.includes(role) && also === true);
export const unassignsLoads = (from, to, fromAlso = false, toAlso = false) => drives(from, fromAlso) && !drives(to, toAlso);
export const loadsWord = (n) => `${n} load${n === 1 ? '' : 's'}`;
export const unassignWarning = (who, n) => (n > 0 ? `${who} is assigned to ${loadsWord(n)}. Changing their role unassigns them.` : null);
export const confirmText = (who, from, to) => `Change ${who} from ${label(from)} to ${label(to)}? ${ROLE_HELP[to] || ''}`.trim();
export const successText = (who, to, unassigned = 0) => `${who} is now ${label(to)}.${unassigned > 0 ? ` Unassigned from ${loadsWord(unassigned)}; pick a new driver on ${unassigned === 1 ? 'it' : 'them'}.` : ''} It takes effect right away; if they have the app open, they’ll see the new menus after a reload.`;
// Team list after a successful change: the row shows the role set_member_role returned (no flash of the old role).
export function applyRoleResult(list, userId, role, alsoDrives) {
  if (!Array.isArray(list) || !userId || !EDITABLE_ROLES.includes(role)) return list;
  const extra = typeof alsoDrives === 'boolean' ? { also_drives: alsoDrives } : {};
  return list.map((r) => (r && r.id === userId && r.linked === true ? { ...r, role, ...extra } : r));
}
export function applyAlsoDrives(list, userId, on) {
  if (!Array.isArray(list) || !userId) return list;
  return list.map((r) => (r && r.id === userId && r.linked === true ? { ...r, also_drives: on === true } : r));
}
export const NOT_OWNER_ROLE_TEXT = 'Only the company owner can change roles.';

// Database answer → { error, status }. Codes are the exception messages raised by set_member_role / the guard trigger.
const CODES = {
  not_owner: [NOT_OWNER_ROLE_TEXT, 403],
  assigned_driver_not_driver: [DRIVER_GONE_TEXT, 409],
  not_member: ['That person isn’t a member of your company.', 404],
  owner_locked: ['The owner’s role can’t be changed here.', 409],
  last_owner: ['The company owner can’t be removed or demoted.', 409],
  bad_role: ['Pick Driver, Dispatcher or Management.', 422],
  already_driver: ['Drivers already drive. Also drives is for Dispatcher and Management.', 409],
  not_signed_in: ['Sign in again.', 401],
};
export function roleError(e) {
  const m = String(e?.message || '');
  for (const [code, [text, status]] of Object.entries(CODES)) if (m === code || m.includes(code)) return { error: text, status, code };
  if (e?.code === 'PGRST202' || e?.code === '42883' || /set_member_role/.test(m) && /not find|does not exist/i.test(m)) return { error: 'Changing roles needs a database update that hasn’t been applied yet.', status: 503, code: 'setup' };
  if (/^PGRST30[123]$/.test(e?.code || '') || /jwt/i.test(m)) return { error: 'Sign in again.', status: 401, code: 'jwt' };
  return { error: 'Couldn’t change the role. Nothing was changed. Try again.', status: 500, code: 'unknown' };
}

// uc = a Supabase client carrying the CALLER's token (so auth.uid() is the owner, never the service role).
// alsoDrives (boolean) is sent only when given, so this keeps working against the 0800 two-argument function.
export async function setMemberRole(uc, userId, role, alsoDrives) {
  let res;
  const args = { p_user: userId, p_role: role, ...(typeof alsoDrives === 'boolean' ? { p_also_drives: alsoDrives } : {}) };
  try { res = await uc.rpc('set_member_role', args); } catch (e) { return roleError(e); }
  if (res?.error) return roleError(res.error);
  const row = Array.isArray(res?.data) ? res.data[0] : res?.data;
  if (!row || row.new_role !== role) return { error: 'Couldn’t confirm the change. Reload to check.', status: 500, code: 'unknown' };
  return { ok: true, previous: row.old_role, role: row.new_role, unassigned: Number(row.unassigned_loads) || 0, ...(typeof row.also_drives === 'boolean' ? { alsoDrives: row.also_drives } : {}) };
}

export const ALSO_DRIVES_SETUP_TEXT = 'Also drives needs a database update that hasn’t been applied yet.';
// Owner-only toggle: public.set_member_also_drives (20261020000100). → { ok, on, unassigned } | { error, status, code }
export async function setMemberAlsoDrives(uc, userId, on) {
  let res;
  try { res = await uc.rpc('set_member_also_drives', { p_user: userId, p_on: on === true }); } catch (e) { return roleError(e); }
  if (res?.error) {
    const m = String(res.error.message || '');
    if (res.error.code === 'PGRST202' || res.error.code === '42883' || /set_member_also_drives/.test(m)) return { error: ALSO_DRIVES_SETUP_TEXT, status: 503, code: 'setup' };
    return roleError(res.error);
  }
  const row = Array.isArray(res?.data) ? res.data[0] : res?.data;
  if (!row || row.also_drives !== (on === true)) return { error: 'Couldn’t confirm the change. Reload to check.', status: 500, code: 'unknown' };
  return { ok: true, on: row.also_drives, unassigned: Number(row.unassigned_loads) || 0 };
}

// How many of the company's loads this member is the assigned driver on (for the confirmation). Same checks in the
// database (public.member_assigned_load_count). → { count } | { error, status, code }
export async function memberAssignedCount(uc, userId) {
  let res;
  try { res = await uc.rpc('member_assigned_load_count', { p_user: userId }); } catch (e) { return roleError(e); }
  if (res?.error) return roleError(res.error);
  const n = Number(res?.data);
  return Number.isFinite(n) && n >= 0 ? { count: n } : { error: 'Couldn’t check their loads. Try again.', status: 500, code: 'unknown' };
}
