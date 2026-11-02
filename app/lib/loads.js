export const STATUSES = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled'];

// Status pills now use the shared StatusTag (pick 5A). Kept under the old name so pages don't change.
export { default as StatusBadge } from '../components/ui/StatusTag';

const has = (v) => v !== null && v !== undefined && v !== '';

export { fmtMoney } from './money'; // shared formatter (always 2 decimals)

export const fmtNumber = (n, unit = '') => (has(n) ? `${Number(n).toLocaleString('en-US')}${unit}` : '—');

// Appointment formatting lives in stopAppt.js (pure, testable); re-exported so callers don't change.
import { fmtApptDate } from './stopAppt';
export { fmtApptDate, fmtApptWindow, fmtStopAppt, fmtTimeText, noteTime, isDateOnlyAppt } from './stopAppt';

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

