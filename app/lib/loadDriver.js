// Assigned driver + "Show rate to driver" (Marc, Oct 18 2026). Columns and functions come from migration
// 20261018000600_load_driver_rate_members.sql. Until it is applied every helper here reports available:false and
// the forms hide the controls, so nothing is sent that the database can't store.
import { isMissingFunction } from './homeCurrentLoad';
import { DISPATCH_STATUS, PRE_DISPATCH_STATUS, dispatchLoad, statusAfterDriverChange, writeOwnerLoadStatus } from './autoDispatch';

const MISSING_COL = /assigned_driver_user_id|show_rate_to_driver|pickup_number/;
// One message wherever the assigned-driver trigger (0600/0700) can surface: the load points at someone who isn't a
// driver on the company any more (e.g. their role was changed before set_member_role unassigned them).
export const DRIVER_GONE_TEXT = 'This load’s driver is no longer a driver. Pick a new one.';
export const isDriverGone = (error) => /assigned_driver_not_driver/.test(String(error?.message || error || ''));
export const isMissingDriverColumn = (error) => !!error && (['42703', 'PGRST204'].includes(error.code) || /Could not find the|does not exist/i.test(error.message || '')) && MISSING_COL.test(error.message || '');

// Owner-operators drive their own loads (Marc, Oct 20 2026). load_driver_choices() lists only members with role
// Driver, and the owner is never one, so the owner couldn't pick himself. The database already accepts the owner as
// a load's driver (loads_check_assigned_driver: assigned_driver_user_id = loads.user_id is allowed, 0600/0700), so
// the owner's own pages (/loads/new, the load page) add "Me (email)" first. No SQL.
export const SELF_DRIVER_PREFIX = 'Me';
export const OWNER_DRIVER_LABEL = 'Owner (drives this load)';
export function withSelfDriver(choices, self) {
  const list = (choices || []).filter((c) => c && c.user_id !== self?.id);
  if (!self?.id) return list;
  return [{ user_id: self.id, email: self.email ? `${SELF_DRIVER_PREFIX} (${self.email})` : SELF_DRIVER_PREFIX, self: true }, ...list];
}
// Dispatch pages (management / dispatchers): the company owner can be a load's driver, so show him as "Owner"
// rather than "no longer on the company". Assigning him works on existing loads (dispatch_update_load) and, once
// 20261020000100 is applied, on /dispatch/new too (dispatch_create_load accepts the owner).
export function withOwnerDriver(choices, ownerId) {
  const list = (choices || []).filter((c) => c && c.user_id !== ownerId);
  return ownerId ? [...list, { user_id: ownerId, email: OWNER_DRIVER_LABEL, owner: true }] : list;
}

// → { available, choices: [{ user_id, email }], error }
// No ownerId = the signed-in owner's own company: the owner himself is offered first (withSelfDriver).
export async function fetchDriverChoices(supabase, ownerId = null) {
  const { data, error } = await supabase.rpc('load_driver_choices', ownerId ? { p_owner: ownerId } : {});
  if (error) return { available: !isMissingFunction(error), choices: [], error: isMissingFunction(error) ? null : error };
  if (ownerId) return { available: true, choices: data || [], error: null };
  let self = null;
  try { const { data: sd } = await supabase.auth.getSession(); const u = sd?.session?.user; self = u ? { id: u.id, email: u.email || null } : null; } catch { self = null; }
  return { available: true, choices: withSelfDriver(data || [], self), error: null };
}

export const SAVE_ERRORS = {
  assigned_driver_not_driver: DRIVER_GONE_TEXT,
  not_allowed: 'Only the owner, management or a dispatcher can change this.',
  load_not_found: 'Load not found.',
};

// Owner / management / dispatcher. The database checks the role (drivers get not_allowed).
// Passing status + previousDriver also dispatches a booked load when the driver changes, and sends a
// dispatched load back to booked when the driver is removed, through the same owner status write as the
// Dispatch button. The RPC itself only stores the driver and the show-rate flag. No driver → the flag stays off.
// → { ok, row, status } | { ok: false, error, row? }
export async function saveDriverSettings(supabase, loadId, { driverId = null, showRate = false, status = null, previousDriver = null } = {}) {
  const nextDriver = driverId || null;
  const show = !!showRate && !!nextDriver;
  const { data, error } = await supabase.rpc('set_load_driver_settings', { p_load: loadId, p_driver: nextDriver, p_show: show });
  if (error) {
    const code = Object.keys(SAVE_ERRORS).find((k) => (error.message || '').includes(k));
    return { ok: false, error: code ? SAVE_ERRORS[code] : "Couldn't save the driver settings. Please try again.", cause: error };
  }
  const next = statusAfterDriverChange({ status, previousDriver, nextDriver });
  if (status === PRE_DISPATCH_STATUS && next === DISPATCH_STATUS) {
    const d = await dispatchLoad(supabase, { id: loadId, status, channel: 'owner' });
    if (!d.ok) return { ok: false, error: 'The driver was saved, but the load was not dispatched. Tap Dispatch to finish.', cause: d.error, row: data };
    return { ok: true, row: data, status: d.status };
  }
  if (status === DISPATCH_STATUS && next === PRE_DISPATCH_STATUS) {
    const written = await writeOwnerLoadStatus(supabase, { id: loadId, status: next, onlyFrom: DISPATCH_STATUS });
    if (!written.ok) return { ok: false, error: 'The driver was saved, but the load was not moved back to Booked.', cause: written.error, row: data };
    return { ok: true, row: data, status: written.status };
  }
  return { ok: true, row: data, status: status || null };
}

// Label for a driver choice. Emails only (company_members has no names yet).
export const driverLabel = (c) => c?.email || 'Driver';

// Driver card helper text: follows the checkbox as it is now, and says so when that isn't saved yet (#94 QA).
export const RATE_ON_TEXT = 'On: the assigned driver sees the rate and rate per mile for this load.';
export const RATE_OFF_TEXT = 'Off: the assigned driver never sees the rate or rate per mile for this load.';
export function driverRateHelp(show, savedShow = show) {
  const base = show ? RATE_ON_TEXT : RATE_OFF_TEXT;
  return show === savedShow ? base : `${base} Not saved yet.`;
}

// Picker options. → { loading: true } until the driver list has arrived (no "no longer on the company" flash);
// then the list, plus the current driver when he is no longer in it.
export const FORMER_DRIVER_LABEL = 'Current driver (no longer on the company)';
export function driverOptions(choices, currentId, loaded) {
  if (!loaded) return { loading: true, options: [] };
  const list = choices || [];
  const options = currentId && !list.some((c) => c.user_id === currentId) ? [...list, { user_id: currentId, email: FORMER_DRIVER_LABEL }] : list;
  return { loading: false, options };
}
