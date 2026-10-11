export const STATUSES = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled'];

const COLORS = {
  booked: ['#e0e7ff', '#3730a3'],
  dispatched: ['#fef3c7', '#92400e'],
  in_transit: ['#dbeafe', '#1e40af'],
  delivered: ['#dcfce7', '#166534'],
  invoiced: ['#f3e8ff', '#6b21a8'],
  paid: ['#d1fae5', '#065f46'],
  cancelled: ['#f3f4f6', '#6b7280'],
};

export function StatusBadge({ status }) {
  const [bg, fg] = COLORS[status] || ['#f3f4f6', '#374151'];
  return (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: '0.15rem 0.6rem', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
      {(status || 'unknown').replaceAll('_', ' ')}
    </span>
  );
}

const has = (v) => v !== null && v !== undefined && v !== '';

export const fmtMoney = (n) => (has(n)
  ? Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  : '—');

export const fmtNumber = (n, unit = '') => (has(n) ? `${Number(n).toLocaleString('en-US')}${unit}` : '—');

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

export const cityState = (stop) => [stop?.city, stop?.state].filter(Boolean).join(', ');

export function fullAddress(stop) {
  if (!stop) return '';
  const line3 = [cityState(stop), stop.zip].filter(Boolean).join(' ');
  return [stop.address_line1, stop.address_line2, line3].filter(Boolean).join(', ');
}

// List label for a stop: "City, ST", else company name, else "—".
export const stopPlace = (stop) => (stop && (cityState(stop) || stop.company_name)) || '—';

export function stopSummary(stop) {
  if (!stop) return '—';
  const date = fmtApptDate(stop.appointment_start, stop.timezone);
  return date ? `${stopPlace(stop)} · ${date}` : stopPlace(stop);
}
