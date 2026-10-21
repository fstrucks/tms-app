// Per-stop completion (migration 20261020000400): stops.completed_at / completion ('done' | 'skipped') / completed_by.
// Pure, JSX-free (Node tests import it).
const byseq = (load) => [...(load?.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// The column exists (every stop row carries the key, even when null). Before the migration: false → hide the buttons.
export const supportsStopCompletion = (load) => { const st = load?.stops || []; return st.length > 0 && st.every((s) => has(s, 'completed_at')); };
export const isStopDone = (s) => !!s?.completed_at;
export const hasCompletionData = (load) => (load?.stops || []).some(isStopDone);

// When the stops carry the completion columns: first stop not completed (even with none marked yet, so Undo of the
// pickup brings the pickup back); all completed → last stop. null only when the columns are absent (caller falls back
// to the appointment guess).
export function completedNextIndex(load) {
  const st = byseq(load);
  if (!st.length || !supportsStopCompletion(load)) return null;
  const i = st.findIndex((s) => !isStopDone(s));
  return i === -1 ? st.length - 1 : i;
}
export const allStopsDone = (load) => { const st = load?.stops || []; return st.length > 0 && st.every(isStopDone); };

export const stopActionLabel = (stop) => (stop?.stop_type === 'pickup' ? 'Picked up' : stop?.stop_type === 'delivery' ? 'Delivered' : 'Done');
export const STAFF = ['owner', 'management', 'dispatcher'];
// Owner / management / dispatcher on any company load; anyone else only as the load's assigned driver.
export function canCompleteStops(role, load, userId) {
  if (!load) return false;
  if (STAFF.includes(role)) return true;
  return !!userId && load.assigned_driver_user_id === userId;
}

// The most recently completed stop (for Undo).
export function lastCompletedStop(load) {
  return byseq(load).filter(isStopDone).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0] || null;
}

const START_STATUSES = ['booked', 'dispatched'];
// action: 'done' | 'skip' | 'undo' → { stopPatch, status } | { error, status: http }
export function planStopAction(load, stopId, action, { now = new Date().toISOString(), userId = null } = {}) {
  const st = byseq(load);
  const stop = st.find((s) => s.id === stopId);
  if (!stop) return { error: 'Stop not found.', code: 404 };
  if (action === 'undo') {
    if (!isStopDone(stop)) return { noop: true }; // already open (e.g. a second tap): success, no write
    return { stopPatch: { completed_at: null, completion: null, completed_by: null }, status: null };
  }
  if (action !== 'done' && action !== 'skip') return { error: 'Bad request.', code: 400 };
  if (isStopDone(stop)) return { noop: true }; // already marked (stale view / second tap): success, no write
  const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
  const status = action === 'done' && firstPickup?.id === stop.id && START_STATUSES.includes(load.status) ? 'in_transit' : null;
  return { stopPatch: { completed_at: now, completion: action === 'skip' ? 'skipped' : 'done', completed_by: userId }, status };
}
export { START_STATUSES };
