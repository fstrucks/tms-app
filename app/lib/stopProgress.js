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

// Adjustable actual time (Oct 22): the driver may set when the stop really happened. Default now; up to 10 minutes
// ahead (clock drift) and back 30 days. → { at: ISO } | { error }
export const STOP_TIME_MAX_FUTURE_MS = 10 * 60 * 1000;
export const STOP_TIME_MAX_PAST_MS = 30 * 24 * 3600 * 1000;
export function checkStopTime(at, now) {
  const t = Date.parse(at), n = Date.parse(now);
  if (!at || !isFinite(t)) return { error: 'Enter a valid date and time.' };
  if (t > n + STOP_TIME_MAX_FUTURE_MS) return { error: 'That time is in the future.' };
  if (t < n - STOP_TIME_MAX_PAST_MS) return { error: 'That time is more than 30 days ago.' };
  return { at: new Date(t).toISOString() };
}
// <input type="datetime-local"> value (device local time) ⇄ ISO.
const pad = (n) => String(n).padStart(2, '0');
export function toLocalInput(iso) {
  const d = new Date(iso); if (!isFinite(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v) { const d = new Date(v); return v && isFinite(d) ? d.toISOString() : null; }

const START_STATUSES = ['booked', 'dispatched'];
const DELIVER_FROM = ['booked', 'dispatched', 'in_transit'];
// action: 'done' | 'skip' | 'undo' → { stopPatch, status } | { error, status: http }
// 'set_time' { at } changes only the actual time of a completed stop (status untouched). 'done' / 'skip' take an
// optional { at } (default now).
export function planStopAction(load, stopId, action, { now = new Date().toISOString(), userId = null, at = null } = {}) {
  const st = byseq(load);
  const stop = st.find((s) => s.id === stopId);
  if (!stop) return { error: 'Stop not found.', code: 404 };
  if (action === 'set_time') {
    if (!isStopDone(stop)) return { error: 'Mark the stop first, then adjust its time.', code: 409 };
    const t = checkStopTime(at, now); if (t.error) return { error: t.error, code: 422 };
    return { stopPatch: { completed_at: t.at, completion: stop.completion, completed_by: stop.completed_by ?? userId }, status: null, fromStatuses: [] };
  }
  if (action === 'undo') {
    if (!isStopDone(stop)) return { noop: true }; // already open (e.g. a second tap): success, no write
    // Undo of the first pickup while nothing else is marked: back to dispatched, so the card shows the pickup again
    // (an in_transit load with no marks counts the pickup as done).
    const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
    const othersDone = st.some((s) => s.id !== stop.id && isStopDone(s));
    const status = firstPickup?.id === stop.id && !othersDone && load.status === 'in_transit' ? 'dispatched' : null;
    return { stopPatch: { completed_at: null, completion: null, completed_by: null }, status, fromStatuses: ['in_transit'] };
  }
  if (action === 'deliver') {
    // Explicit "Mark load delivered" once every stop is checked off (also the fix path for loads whose last stop was
    // marked before the final-stop rule below existed).
    if (!allStopsDone(load)) return { error: 'Check off every stop first.', code: 409 };
    if (load.status === 'delivered') return { noop: true };
    if (!DELIVER_FROM.includes(load.status)) return { error: 'This load can’t be marked delivered from its current status.', code: 409 };
    return { stopPatch: null, status: 'delivered', fromStatuses: DELIVER_FROM };
  }
  if (action !== 'done' && action !== 'skip') return { error: 'Bad request.', code: 400 };
  if (isStopDone(stop)) return { noop: true }; // already marked (stale view / second tap): success, no write
  let when = now;
  if (at != null && at !== '') { const t = checkStopTime(at, now); if (t.error) return { error: t.error, code: 422 }; when = t.at; }
  const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
  let status = action === 'done' && firstPickup?.id === stop.id && START_STATUSES.includes(load.status) ? 'in_transit' : null;
  // Marking the final open stop done (with at least one delivery stop delivered) delivers the load. This fires the
  // auto-draft invoice trigger, same as picking Delivered by hand.
  const othersOpen = st.some((s) => s.id !== stop.id && !isStopDone(s));
  const anyDelivered = st.some((s) => s.stop_type === 'delivery' && (s.id === stop.id ? action === 'done' : s.completion === 'done'));
  if (!othersOpen && anyDelivered && DELIVER_FROM.includes(load.status)) status = 'delivered';
  return { stopPatch: { completed_at: when, completion: action === 'skip' ? 'skipped' : 'done', completed_by: userId }, status, fromStatuses: status === 'delivered' ? DELIVER_FROM : START_STATUSES };
}
export { START_STATUSES, DELIVER_FROM };
