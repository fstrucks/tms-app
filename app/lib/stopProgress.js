// Per-stop completion (migration 20261020000400): stops.completed_at / completion ('done' | 'skipped') / completed_by.
// Pure, JSX-free (Node tests import it).
const IMPLIED_PICKED = ['in_transit'];
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
  // In transit with nothing marked (picked up before check-off existed, or status set by hand): the first pickup is
  // implicitly done. Undo of that pickup moves the load back to dispatched (server), so the pickup shows again.
  if (!st.some(isStopDone) && IMPLIED_PICKED.includes(load?.status)) {
    const p = st.findIndex((s) => s.stop_type === 'pickup');
    const after = (p === -1 ? 0 : p) + 1;
    return after < st.length ? after : st.length - 1;
  }
  const i = st.findIndex((s) => !isStopDone(s));
  return i === -1 ? st.length - 1 : i;
}
export const allStopsDone = (load) => { const st = load?.stops || []; return st.length > 0 && st.every(isStopDone); };

// Button text is an ACTION (Marc, Oct 20: a bare "Delivered" read like a status). stopDoneLabel is the past tense
// shown on a completed stop / in Undo.
export const stopActionLabel = (stop) => (stop?.stop_type === 'pickup' ? 'Mark as picked up' : stop?.stop_type === 'delivery' ? 'Mark as delivered' : 'Mark as done');
export const stopDoneLabel = (stop) => (stop?.stop_type === 'pickup' ? 'Picked up' : stop?.stop_type === 'delivery' ? 'Delivered' : 'Done');
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
    // Undo of the first pickup while nothing else is marked: back to dispatched, so the card shows the pickup again
    // (an in_transit load with no marks counts the pickup as done).
    const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
    const othersDone = st.some((s) => s.id !== stop.id && isStopDone(s));
    const status = firstPickup?.id === stop.id && !othersDone && load.status === 'in_transit' ? 'dispatched' : null;
    return { stopPatch: { completed_at: null, completion: null, completed_by: null }, status, fromStatuses: ['in_transit'] };
  }
  if (action !== 'done' && action !== 'skip') return { error: 'Bad request.', code: 400 };
  if (isStopDone(stop)) return { noop: true }; // already marked (stale view / second tap): success, no write
  const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
  const status = action === 'done' && firstPickup?.id === stop.id && START_STATUSES.includes(load.status) ? 'in_transit' : null;
  return { stopPatch: { completed_at: now, completion: action === 'skip' ? 'skipped' : 'done', completed_by: userId }, status, fromStatuses: START_STATUSES };
}
export { START_STATUSES };
