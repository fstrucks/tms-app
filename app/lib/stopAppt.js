// Stop appointment display (Home current-load card, load page). Pure: no React imports.
// Intl formatter in the stop's own IANA zone; falls back to the browser zone if the zone is null/invalid.
function fmt(tz, opts) {
  if (tz) {
    try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }); } catch { /* invalid zone */ }
  }
  return new Intl.DateTimeFormat(undefined, opts);
}

const part = (f, d, type) => f.formatToParts(d).find((p) => p.type === type)?.value || '';

export function fmtApptDate(ts, tz) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : fmt(tz, { month: 'short', day: 'numeric' }).format(d);
}

// Appointment window in the stop's zone, e.g. "Tue, Oct 13 2:00 PM–4:00 PM EDT".
export function fmtApptWindow(start, end, tz) {
  if (!start) return '';
  const s = new Date(start);
  if (isNaN(s)) return '';
  const dateF = fmt(tz, { weekday: 'short', month: 'short', day: 'numeric' });
  const timeF = fmt(tz, { hour: 'numeric', minute: '2-digit' });
  const zoneF = fmt(tz, { timeZoneName: 'short' });
  const dayKey = fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const zone = part(zoneF, s, 'timeZoneName');
  const suffix = zone ? ` ${zone}` : '';
  const e = end ? new Date(end) : null;
  if (!e || isNaN(e)) return `${dateF.format(s)} ${timeF.format(s)}${suffix}`;
  return dayKey.format(s) === dayKey.format(e)
    ? `${dateF.format(s)} ${timeF.format(s)}–${timeF.format(e)}${suffix}`
    : `${dateF.format(s)} ${timeF.format(s)} – ${dateF.format(e)} ${timeF.format(e)}${suffix}`;
}

// A stop's appointment as drivers should read it (Home card and load page).
// Rate con loads whose time couldn't be parsed (e.g. "14:00 - 16:00") are saved by the create-load RPC as the DATE at
// local midnight in the stop's zone, with the raw time kept in the notes as "Time: …". Formatting that timestamp
// showed "12:00 AM". Here: a midnight start with no end is a date-only appointment; the "Time:" note (if any) is
// shown as the time window, e.g. "Tue, Nov 3 2:00 PM–4:00 PM PST", else just "Tue, Nov 3".
// Trade-off: a real 12:00 AM appointment with no end and no Time note also reads as date-only.
export const noteTime = (notes) => {
  const m = /^\s*Time:\s*(.+?)\s*$/im.exec(String(notes || ''));
  return m ? m[1] : '';
};
function clock(t) { // "14:00" / "2pm" / "2:30 PM" / "1400" → { h, m } or null
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*([ap])?\.?\s*m?\.?$/i.exec(String(t).trim());
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3]?.toLowerCase();
  if (min > 59 || h > 24 || (ap && (h < 1 || h > 12))) return null;
  if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
  if (h === 24) { if (min) return null; h = 0; }
  return { h, m: min };
}
const clockText = ({ h, m }) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
export function fmtTimeText(raw) { // "14:00 - 16:00" → "2:00 PM–4:00 PM"; unparseable → as written
  const s = String(raw || '').trim();
  if (!s) return '';
  const parts = s.split(/\s*(?:-|–|—|to)\s*/i);
  const c = parts.map(clock);
  if (parts.length <= 2 && c.every(Boolean)) return c.map(clockText).join('–');
  return s;
}
export function isDateOnlyAppt(start, end, tz) {
  if (!start || end) return false;
  const d = new Date(start);
  if (isNaN(d)) return false;
  const f = fmt(tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return f.format(d).replace(/^24/, '00') === '00:00:00';
}
export function fmtStopAppt(stop) {
  const { appointment_start: start, appointment_end: end, timezone: tz } = stop || {};
  if (!isDateOnlyAppt(start, end, tz)) return fmtApptWindow(start, end, tz);
  const d = new Date(start);
  const date = fmt(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const t = fmtTimeText(noteTime(stop.notes));
  if (!t) return date;
  const zone = part(fmt(tz, { timeZoneName: 'short' }), d, 'timeZoneName');
  return `${date} ${t}${zone ? ` ${zone}` : ''}`;
}
