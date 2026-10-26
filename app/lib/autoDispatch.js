// Assigning a driver dispatches the load (Marc, via Sam, Oct 25 2026).
// Dispatch today is only a status write to 'dispatched': the owner load page updates public.loads
// (own-row RLS) and the dispatch editor calls public.dispatch_update_load. There is no dispatched_at,
// no email, no push, and no driver-accept link. The Home map appears because a dispatched load is the
// "Current load" card (app/components/HomeCurrentLoad.js enables the map only for that card).
// Both the Dispatch button and every assign path use the helpers here so the status decision cannot drift.
// Office roles only. Drivers have no assign or dispatch control; the writes stay on the existing
// owner update and the role-checked dispatch RPC.

export const DISPATCH_STATUS = 'dispatched';
// The only status before dispatch. in_transit is already picked up. delivered / invoiced / paid / cancelled are terminal.
export const PRE_DISPATCH_STATUS = 'booked';
export const TERMINAL_STATUSES = ['delivered', 'invoiced', 'paid', 'cancelled'];

const idOf = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

// Status after a driver change (Marc, via Sam, Oct 25 2026).
// A new or different driver on a booked load becomes dispatched.
// Removing the driver from a dispatched load sends it back to booked. A driver swap (A to B) stays dispatched.
// in_transit, delivered, invoiced, paid, cancelled, and booked are never moved by an unassign.
// An explicit status other than booked (in transit, cancelled, a manual Dispatch, …) still wins.
export function statusAfterDriverChange({ status = null, previousDriver = null, nextDriver = null, explicitStatus = null } = {}) {
  const current = status || null;
  const prev = idOf(previousDriver);
  const next = idOf(nextDriver);
  if (explicitStatus && explicitStatus !== PRE_DISPATCH_STATUS) return explicitStatus;
  if (!next && current === DISPATCH_STATUS) return PRE_DISPATCH_STATUS;
  if (!next || next === prev) return explicitStatus || current;
  if (current === PRE_DISPATCH_STATUS) return DISPATCH_STATUS;
  return explicitStatus || current;
}

export const REVERT_TO_BOOKED_TEXT = 'Saved. Load is back to Booked.';
export const DRIVER_SAVED_TEXT = 'Driver saved.';
export const SAVED_DISPATCHED_TEXT = 'Saved and dispatched.';

// Copy after a driver or load save. Unassign of a dispatched load is named; a driver change that
// leaves the status alone says the driver was saved (the owner card used to say nothing changed).
export function savedDriverMessage({ previousStatus = null, nextStatus = null, driverChanged = false } = {}) {
  if (previousStatus === DISPATCH_STATUS && nextStatus === PRE_DISPATCH_STATUS) return REVERT_TO_BOOKED_TEXT;
  if (previousStatus === PRE_DISPATCH_STATUS && nextStatus === DISPATCH_STATUS) return SAVED_DISPATCHED_TEXT;
  if (driverChanged) return DRIVER_SAVED_TEXT;
  return 'Saved.';
}

// Manual Dispatch. Booked becomes dispatched. Anything else is left alone (no re-dispatch, no terminal change).
export function statusAfterDispatch(status) {
  return status === PRE_DISPATCH_STATUS ? DISPATCH_STATUS : status;
}

// New load that includes a driver. Booked (or omitted) becomes dispatched. Any other explicit status stays.
// No driver: the caller's status, or null when they didn't set one. Applying this twice is the same as once.
export function statusForNewAssignedLoad(load) {
  if (!load) return null;
  if (!idOf(load.assigned_driver_user_id)) return load.status ?? null;
  return statusAfterDriverChange({
    status: PRE_DISPATCH_STATUS,
    previousDriver: null,
    nextDriver: load.assigned_driver_user_id,
    explicitStatus: load.status && load.status !== PRE_DISPATCH_STATUS ? load.status : null,
  });
}

// Dispatch stays available when a driver is already assigned and the load is still booked.
export function showDispatchButton({ status, driverId } = {}) {
  return status === PRE_DISPATCH_STATUS && !!idOf(driverId);
}

// Dropdown while the driver select changes. A booked load shows Dispatched once the driver is new.
// Clearing the driver on that automatic Dispatched, or on a load already dispatched, puts Booked back.
// A status the user picked (in transit, cancelled, delivered, …) stays.
export function formStatusOnDriverPick({ savedStatus = null, savedDriver = null, nextDriver = null, formStatus = null } = {}) {
  const saved = savedStatus || PRE_DISPATCH_STATUS;
  let explicit = formStatus && formStatus !== saved ? formStatus : null;
  if (explicit === DISPATCH_STATUS && saved === PRE_DISPATCH_STATUS) explicit = null;
  return statusAfterDriverChange({
    status: saved, previousDriver: savedDriver, nextDriver, explicitStatus: explicit,
  }) || formStatus || saved;
}

// Dropdown while the status select changes. Booked snaps back to Dispatched when the driver is new.
// Any other status is kept, including un-dispatch when the driver did not change.
export function formStatusOnStatusPick({ savedStatus = null, savedDriver = null, formDriver = null, pickedStatus = null } = {}) {
  const saved = savedStatus || PRE_DISPATCH_STATUS;
  const explicit = pickedStatus && pickedStatus !== saved ? pickedStatus : null;
  return statusAfterDriverChange({
    status: saved, previousDriver: savedDriver, nextDriver: formDriver, explicitStatus: explicit,
  }) || pickedStatus || saved;
}

// Owner status write: the same loads.update the load page status menu uses. onlyFrom guards a raced status.
export async function writeOwnerLoadStatus(supabase, { id, status, onlyFrom = null } = {}) {
  let q = supabase.from('loads').update({ status }).eq('id', id);
  if (onlyFrom) q = q.eq('status', onlyFrom);
  const { data, error } = await q.select('status').maybeSingle();
  if (error) return { ok: false, error };
  if (!data?.status) return { ok: false, error: { message: 'not_updated' } };
  return { ok: true, status: data.status };
}

// The Dispatch write. channel 'owner' uses writeOwnerLoadStatus. channel 'staff' uses the dispatch editor's
// save (public.dispatch_update_load), passed in so this file does not import the dispatch form module.
// → { ok, status, skipped } | { ok: false, error, message, status }
export async function dispatchLoad(supabase, { id, status, channel = 'owner', saveStaff } = {}) {
  const next = statusAfterDispatch(status);
  if (!id || next === status) return { ok: true, status: status ?? null, skipped: true };
  if (channel === 'staff') {
    if (typeof saveStaff !== 'function') return { ok: false, status, error: { message: 'not_allowed' }, message: 'Only management and dispatchers can change loads here.' };
    const r = await saveStaff(supabase, id, { status: next });
    if (!r?.ok) return { ok: false, status, error: r?.cause || r?.error || null, message: r?.error || 'Couldn’t dispatch. Please try again.' };
    return { ok: true, status: r.load?.status || next, load: r.load || null, skipped: false };
  }
  const written = await writeOwnerLoadStatus(supabase, { id, status: next, onlyFrom: PRE_DISPATCH_STATUS });
  if (!written.ok) return { ok: false, status, error: written.error, message: 'Couldn’t dispatch. Please try again.' };
  return { ok: true, status: written.status, skipped: false };
}
