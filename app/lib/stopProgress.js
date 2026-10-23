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

// The most recently completed stop (for Undo): latest completed_at as an INSTANT, ties / unparseable → the highest
// sequence. QA Oct 22: the old string compare kept sequence order on a tie (pickup and delivery saved in the same
// request time) and misordered mixed formats ('…Z' vs '…+00:00', fractional seconds), so Undo offered stop 1 on a
// Delivered load.
const doneAt = (s) => { const t = Date.parse(s?.completed_at); return isFinite(t) ? t : -Infinity; };
export function lastCompletedStop(load) {
  return byseq(load).filter(isStopDone).sort((a, b) => (doneAt(b) - doneAt(a)) || ((b.sequence ?? 0) - (a.sequence ?? 0)))[0] || null;
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

// "Arrived" step (migration 20261022170000): stops.arrived_at / arrived_by. Optional; never changes the load status.
export const supportsArrival = (load) => { const st = load?.stops || []; return st.length > 0 && st.every((s) => has(s, 'arrived_at')); };
export const isArrived = (s) => !!s?.arrived_at;
export const arriveLabel = (stop) => (stop?.stop_type === 'pickup' ? 'Arrived at shipper' : stop?.stop_type === 'delivery' ? 'Arrived at receiver' : 'Arrived');
// Minutes on site: arrived → picked up / delivered. null when either is missing or the stop was skipped.
export function minutesOnSite(stop) {
  if (!stop?.arrived_at || !stop?.completed_at || stop.completion === 'skipped') return null;
  const m = Math.round((Date.parse(stop.completed_at) - Date.parse(stop.arrived_at)) / 60000);
  return isFinite(m) && m >= 0 ? m : null;
}
export const fmtDuration = (m) => (m == null ? null : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`);

const START_STATUSES = ['booked', 'dispatched'];
const DELIVER_FROM = ['booked', 'dispatched', 'in_transit'];
// action: 'done' | 'skip' | 'undo' → { stopPatch, status } | { error, status: http }
// 'set_time' { at } changes only the actual time of a completed stop (status untouched). 'done' / 'skip' take an
// optional { at } (default now).
export function planStopAction(load, stopId, action, { now = new Date().toISOString(), userId = null, at = null, field = 'completed' } = {}) {
  const st = byseq(load);
  const stop = st.find((s) => s.id === stopId);
  if (!stop) return { error: 'Stop not found.', code: 404 };
  if (action === 'arrive') {
    if (isStopDone(stop) || isArrived(stop)) return { noop: true };
    let when = now;
    if (at != null && at !== '') { const t = checkStopTime(at, now); if (t.error) return { error: t.error, code: 422 }; when = t.at; }
    return { stopPatch: { arrived_at: when, arrived_by: userId }, status: null, fromStatuses: [] };
  }
  if (action === 'undo_arrive') {
    if (!isArrived(stop)) return { noop: true };
    if (isStopDone(stop)) return { error: 'Undo the stop first.', code: 409 };
    return { stopPatch: { arrived_at: null, arrived_by: null }, status: null, fromStatuses: [] };
  }
  if (action === 'set_time') {
    // field: 'completed' (default) | 'arrived'. Arrived can't be after the completion time, and vice versa.
    const t = checkStopTime(at, now); if (t.error) return { error: t.error, code: 422 };
    if (field === 'arrived') {
      if (!isArrived(stop)) return { error: 'Mark arrived first, then adjust its time.', code: 409 };
      if (stop.completed_at && stop.completion === 'done' && Date.parse(t.at) > Date.parse(stop.completed_at)) return { error: 'Arrival can’t be after the stop was completed.', code: 422 };
      return { stopPatch: { arrived_at: t.at, arrived_by: stop.arrived_by ?? userId }, status: null, fromStatuses: [] };
    }
    if (!isStopDone(stop)) return { error: 'Mark the stop first, then adjust its time.', code: 409 };
    if (stop.arrived_at && Date.parse(t.at) < Date.parse(stop.arrived_at)) return { error: 'That’s before the arrival time.', code: 422 };
    return { stopPatch: { completed_at: t.at, completion: stop.completion, completed_by: stop.completed_by ?? userId }, status: null, fromStatuses: [] };
  }
  if (action === 'undo') {
    if (!isStopDone(stop)) return { noop: true }; // already open (e.g. a second tap): success, no write
    // Only the most recent stop can be undone (a stale screen could otherwise reopen the pickup under a delivered stop).
    if (lastCompletedStop(load)?.id !== stop.id) return { error: 'Undo the most recent stop first.', code: 409 };
    // Undo of the first pickup while nothing else is marked: back to dispatched, so the card shows the pickup again
    // (an in_transit load with no marks counts the pickup as done).
    const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
    const othersDone = st.some((s) => s.id !== stop.id && isStopDone(s));
    const onlyFirstPickup = firstPickup?.id === stop.id && !othersDone;
    const stopPatch = { completed_at: null, completion: null, completed_by: null };
    // Undo on a Delivered load (QA Oct 22): the load is no longer delivered → back to In transit (or Dispatched when
    // that leaves nothing marked). Invoiced / paid loads keep their status.
    if (load.status === 'delivered') return { stopPatch, status: onlyFirstPickup ? 'dispatched' : 'in_transit', fromStatuses: ['delivered'] };
    const status = onlyFirstPickup && load.status === 'in_transit' ? 'dispatched' : null;
    return { stopPatch, status, fromStatuses: ['in_transit'] };
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
  if (action === 'done' && stop.arrived_at && Date.parse(when) < Date.parse(stop.arrived_at)) return { error: 'That’s before the arrival time.', code: 422 };
  const firstPickup = st.find((s) => s.stop_type === 'pickup') || st[0];
  let status = action === 'done' && firstPickup?.id === stop.id && START_STATUSES.includes(load.status) ? 'in_transit' : null;
  // Marking the final open stop done (with at least one delivery stop delivered) delivers the load. This fires the
  // auto-draft invoice trigger, same as picking Delivered by hand.
  const othersOpen = st.some((s) => s.id !== stop.id && !isStopDone(s));
  const anyDelivered = st.some((s) => s.stop_type === 'delivery' && (s.id === stop.id ? action === 'done' : s.completion === 'done'));
  if (!othersOpen && anyDelivered && DELIVER_FROM.includes(load.status)) status = 'delivered';
  return { stopPatch: { completed_at: when, completion: action === 'skip' ? 'skipped' : 'done', completed_by: userId }, status, fromStatuses: status === 'delivered' ? DELIVER_FROM : START_STATUSES };
}
// Every patched field reads back as written (timestamps compared as instants).
export function patchApplied(row, patch) {
  return Object.entries(patch).every(([k, v]) => (v == null ? row[k] == null : k.endsWith('_at') ? Date.parse(row[k]) === Date.parse(v) : row[k] === v));
}
export { START_STATUSES, DELIVER_FROM };
