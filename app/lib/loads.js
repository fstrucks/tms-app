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

export const fmtMoney = (n) => (n === null || n === undefined || n === '' ? '—'
  : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

export function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(`${d}T00:00:00`);
  return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Best-effort "City, ST" from a free-form US address.
export function cityFromAddress(addr) {
  if (!addr) return '';
  const parts = addr.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return `${parts[parts.length - 2]}, ${parts[parts.length - 1].split(' ')[0]}`;
  if (parts.length === 2) return `${parts[0]}, ${parts[1].split(' ')[0]}`;
  return parts[0] || '';
}

export function stopSummary(stop) {
  if (!stop) return '—';
  const place = cityFromAddress(stop.address) || stop.name || '—';
  const date = fmtDate(stop.scheduled_date);
  return date ? `${place} · ${date}` : place;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Build load + stop rows from documents.ai_extracted_data.
export function loadFromExtraction(x) {
  const rate = typeof x?.rate === 'number' ? x.rate : null;
  const load = {
    status: 'booked',
    broker_name: x?.broker_name || null,
    load_number: x?.load_number || null,
    reference_numbers: Array.isArray(x?.reference_numbers) && x.reference_numbers.length ? x.reference_numbers : null,
    rate,
    notes: x?.notes || null,
  };
  const stop = (type, seq, party, when) => {
    const date = when?.date && ISO_DATE.test(when.date) ? when.date : null;
    const timeBits = [when?.time, when?.date && !date ? when.date : null].filter(Boolean);
    return {
      sequence: seq,
      stop_type: type,
      name: party?.name || null,
      address: when?.address || party?.address || null,
      scheduled_date: date,
      scheduled_time: timeBits.length ? timeBits.join(' ') : null,
    };
  };
  return {
    load,
    stops: [stop('pickup', 1, x?.shipper, x?.pickup), stop('delivery', 2, x?.receiver, x?.delivery)],
  };
}
