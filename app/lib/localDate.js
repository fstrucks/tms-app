// Calendar day of a stored instant, in the viewer's timezone. created_at is a timestamptz and stays UTC in the database.
// A bare "YYYY-MM-DD HH:MM:SS" (Postgres when the offset is dropped) is UTC, same as parseUtc. The zone argument
// is the browser zone when omitted, so an evening upload is that evening's date, not the next UTC day.
import { parseUtc } from './packetDate';

export function formatLocalDate(value, timeZone) {
  if (value == null || value === '') return '';
  const t = parseUtc(value);
  if (Number.isNaN(t.getTime())) return '';
  const opts = { month: 'numeric', day: 'numeric', year: 'numeric' };
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(t);
    } catch { /* unknown zone: use the runtime zone */ }
  }
  return new Intl.DateTimeFormat('en-US', opts).format(t);
}

// Same local calendar day as formatLocalDate, as YYYY-MM-DD. A date-only value is already a calendar day and stays.
export function localISODate(value, timeZone) {
  const s = value == null ? '' : String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const shown = formatLocalDate(value, timeZone);
  if (!shown) return '';
  const [month, day, year] = shown.split('/');
  if (!year || !month || !day) return '';
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
