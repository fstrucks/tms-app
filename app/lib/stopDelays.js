// Delays at a stop (migration 20261022170000: stop_delays). Pure, JSX-free (Node tests and the server import it).
import { checkStopTime } from './stopProgress.js';

export const DELAY_REASONS = [
  ['waiting_to_load', 'Waiting to load'], ['waiting_to_unload', 'Waiting to unload'], ['facility_closed', 'Facility closed'],
  ['breakdown', 'Breakdown'], ['weather', 'Weather'], ['traffic', 'Traffic'], ['other', 'Other'],
];
const REASON_IDS = DELAY_REASONS.map(([id]) => id);
export const delayReasonLabel = (id) => DELAY_REASONS.find(([k]) => k === id)?.[1] || 'Delay';
export const NOTE_MAX = 300;

// Client body → { row: { reason, note, started_at, ended_at } } | { error }. Start defaults to now; end is optional
// (blank = still delayed). Same limits as stop times; the end can't be before the start.
export function cleanDelay(body = {}, now = new Date().toISOString()) {
  const reason = String(body.reason || '');
  if (!REASON_IDS.includes(reason)) return { error: 'Pick a reason for the delay.' };
  const note = String(body.note ?? '').trim().slice(0, NOTE_MAX) || null;
  if (reason === 'other' && !note) return { error: 'Add a note saying what the delay was.' };
  const s = checkStopTime(body.started_at || now, now); if (s.error) return { error: `Start: ${s.error}` };
  let ended = null;
  if (body.ended_at) {
    const e = checkStopTime(body.ended_at, now); if (e.error) return { error: `End: ${e.error}` };
    if (Date.parse(e.at) < Date.parse(s.at)) return { error: 'The end is before the start.' };
    ended = e.at;
  }
  return { row: { reason, note, started_at: s.at, ended_at: ended } };
}

export function delayMinutes(d) {
  if (!d?.started_at || !d?.ended_at) return null;
  const m = Math.round((Date.parse(d.ended_at) - Date.parse(d.started_at)) / 60000);
  return isFinite(m) && m >= 0 ? m : null;
}
export const delaysForStop = (delays, stopId) => (delays || []).filter((d) => d.stop_id === stopId).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
export const isMissingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /stop_delays/.test(e.message || '') && /does not exist|schema cache/.test(e.message || ''));
