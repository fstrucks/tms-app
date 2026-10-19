// Assigned driver + "Show rate to driver" (Marc, Oct 18 2026). Columns and functions come from migration
// 20261018000600_load_driver_rate_members.sql. Until it is applied every helper here reports available:false and
// the forms hide the controls, so nothing is sent that the database can't store.
import { isMissingFunction } from './homeCurrentLoad';

const MISSING_COL = /assigned_driver_user_id|show_rate_to_driver|pickup_number/;
// One message wherever the assigned-driver trigger (0600/0700) can surface: the load points at someone who isn't a
// driver on the company any more (e.g. their role was changed before set_member_role unassigned them).
export const DRIVER_GONE_TEXT = 'This load’s driver is no longer a driver. Pick a new one.';
export const isDriverGone = (error) => /assigned_driver_not_driver/.test(String(error?.message || error || ''));
export const isMissingDriverColumn = (error) => !!error && (['42703', 'PGRST204'].includes(error.code) || /Could not find the|does not exist/i.test(error.message || '')) && MISSING_COL.test(error.message || '');

// → { available, choices: [{ user_id, email }], error }
export async function fetchDriverChoices(supabase, ownerId = null) {
  const { data, error } = await supabase.rpc('load_driver_choices', ownerId ? { p_owner: ownerId } : {});
  if (error) return { available: !isMissingFunction(error), choices: [], error: isMissingFunction(error) ? null : error };
  return { available: true, choices: data || [], error: null };
}

export const SAVE_ERRORS = {
  assigned_driver_not_driver: DRIVER_GONE_TEXT,
  not_allowed: 'Only the owner, management or a dispatcher can change this.',
  load_not_found: 'Load not found.',
};

// Owner / management / dispatcher. → { ok, row } | { ok: false, error }
export async function saveDriverSettings(supabase, loadId, { driverId = null, showRate = false } = {}) {
  const { data, error } = await supabase.rpc('set_load_driver_settings', { p_load: loadId, p_driver: driverId || null, p_show: !!showRate });
  if (error) {
    const code = Object.keys(SAVE_ERRORS).find((k) => (error.message || '').includes(k));
    return { ok: false, error: code ? SAVE_ERRORS[code] : "Couldn't save the driver settings. Please try again.", cause: error };
  }
  return { ok: true, row: data };
}

// Label for a driver choice. Emails only (company_members has no names yet).
export const driverLabel = (c) => c?.email || 'Driver';
