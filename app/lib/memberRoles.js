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
  return { userId: b.user_id.trim(), role: b.role.trim() };
}
// Same id check for the "how many loads" lookup. → { userId } | { error, status }
export function validateMemberId(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.user_id !== 'string' || !UUID.test(b.user_id.trim())) return { error: 'Which person? Pick someone from the list.', status: 422 };
  return { userId: b.user_id.trim() };
}

// Moving a driver to another role unassigns them from the company's loads (set_member_role does it in the database).
export const unassignsLoads = (from, to) => from === 'driver' && to !== 'driver';
export const loadsWord = (n) => `${n} load${n === 1 ? '' : 's'}`;
export const unassignWarning = (who, n) => (n > 0 ? `${who} is assigned to ${loadsWord(n)}. Changing their role unassigns them.` : null);
export const confirmText = (who, from, to) => `Change ${who} from ${label(from)} to ${label(to)}? ${ROLE_HELP[to] || ''}`.trim();
export const successText = (who, to, unassigned = 0) => `${who} is now ${label(to)}.${unassigned > 0 ? ` Unassigned from ${loadsWord(unassigned)}; pick a new driver on ${unassigned === 1 ? 'it' : 'them'}.` : ''} It takes effect right away; if they have the app open, they’ll see the new menus after a reload.`;
export const NOT_OWNER_ROLE_TEXT = 'Only the company owner can change roles.';

// Database answer → { error, status }. Codes are the exception messages raised by set_member_role / the guard trigger.
const CODES = {
  not_owner: [NOT_OWNER_ROLE_TEXT, 403],
  assigned_driver_not_driver: [DRIVER_GONE_TEXT, 409],
  not_member: ['That person isn’t a member of your company.', 404],
  owner_locked: ['The owner’s role can’t be changed here.', 409],
  last_owner: ['The company owner can’t be removed or demoted.', 409],
  bad_role: ['Pick Driver, Dispatcher or Management.', 422],
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
export async function setMemberRole(uc, userId, role) {
  let res;
  try { res = await uc.rpc('set_member_role', { p_user: userId, p_role: role }); } catch (e) { return roleError(e); }
  if (res?.error) return roleError(res.error);
  const row = Array.isArray(res?.data) ? res.data[0] : res?.data;
  if (!row || row.new_role !== role) return { error: 'Couldn’t confirm the change. Reload to check.', status: 500, code: 'unknown' };
  return { ok: true, previous: row.old_role, role: row.new_role, unassigned: Number(row.unassigned_loads) || 0 };
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
