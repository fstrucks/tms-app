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

export { fmtMoney } from './money'; // shared formatter (always 2 decimals)

export const fmtNumber = (n, unit = '') => (has(n) ? `${Number(n).toLocaleString('en-US')}${unit}` : '—');

export function fmtApptDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtApptWindow(start, end) {
  if (!start) return '';
  const s = new Date(start);
  if (isNaN(s)) return '';
  const date = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  // Shown in the browser's local time.
  const t = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(s).find((p) => p.type === 'timeZoneName')?.value;
  const suffix = tz ? ` ${tz}` : '';
  const e = end ? new Date(end) : null;
  if (!e || isNaN(e)) return `${date} ${t(s)}${suffix}`;
  return s.toDateString() === e.toDateString() ? `${date} ${t(s)}–${t(e)}${suffix}` : `${date} ${t(s)} – ${e.toLocaleDateString()} ${t(e)}${suffix}`;
}

export const cityState = (stop) => [stop?.city, stop?.state].filter(Boolean).join(', ');

export function fullAddress(stop) {
  if (!stop) return '';
  const line3 = [cityState(stop), stop.zip].filter(Boolean).join(' ');
  return [stop.address_line1, stop.address_line2, line3].filter(Boolean).join(', ');
}

export function stopSummary(stop) {
  if (!stop) return '—';
  const place = cityState(stop) || stop.company_name || '—';
  const date = fmtApptDate(stop.appointment_start);
  return date ? `${place} · ${date}` : place;
}
