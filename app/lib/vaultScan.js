// Maintenance vault scanning: shapes a scanned shop invoice / work order into Log service form values.
// Pure helpers (no I/O) so they're unit-tested. Nothing here saves anything; the user confirms the form.
import { SERVICE_TYPES } from './maintenance.js';

const TYPES = new Set(SERVICE_TYPES.map(([k]) => k));
// Keyword fallback, checked in order (more specific first). Used when the scan's service_type is missing or 'other'.
const RULES = [
  ['coolant_filter', /coolant\s*filter|water\s*filter/],
  ['def_filter', /\bdef\b.*filter|filter.*\bdef\b|urea|dosing/],
  ['fuel_filters', /fuel\s*(?:filter|water\s*sep)|\bfuel\/water\b|primary\s*filter|secondary\s*filter/],
  ['air_filter', /air\s*(?:filter|cleaner)|air\s*element/],
  ['oil_filter', /\boil\b|lube\s*oil|\bpm[\s-]?a\b|lof\b|15w-?40|10w-?30/],
  ['coolant', /coolant|antifreeze|radiator\s*flush|\belc\b/],
  ['valve_adjustment', /valve|overhead\s*adj|\boverhead\b/],
  ['transmission', /transmission|\btrans\b/],
  ['differential', /differential|\bdiff\b|rear\s*end|axle\s*(?:oil|fluid|lube)/],
  ['tires', /\btires?\b|\btyres?\b|steer\s*tire|drive\s*tire|recap/],
  ['brakes', /brake|slack\s*adjust|\bshoes?\b|\bdrums?\b|rotor/],
  ['grease', /grease|chassis\s*lube|\blube\b|fifth\s*wheel/],
  ['dot_annual', /\bdot\b|annual\s*inspection|fhwa|periodic\s*inspection/],
];
export function mapServiceType(desc, given) {
  if (TYPES.has(given) && given !== 'other') return given;
  const s = String(desc || '').toLowerCase();
  for (const [k, re] of RULES) if (re.test(s)) return k;
  return 'other';
}

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);
const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '').replace(/mi(les)?$/i, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const realDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01';
};

// raw: the scan's JSON. today: the client's YYYY-MM-DD (dates after it are dropped, never replaced with today).
// -> { isInvoice, date, odometer, vendor, total, services: [{ type, label, cost }], text }
export function normalizeShopInvoice(raw, { today } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const date = realDate(r.date) && (!today || r.date <= today) ? r.date : null;
  let odometer = num(r.odometer);
  odometer = odometer != null && odometer >= 0 && odometer <= 9_999_999 ? Math.round(odometer) : null;
  let total = num(r.total);
  total = total != null && total >= 0 && total < 1_000_000 ? Math.round(total * 100) / 100 : null;
  const seen = new Map();
  for (const s of Array.isArray(r.services) ? r.services.slice(0, 40) : []) {
    const desc = clip(s?.description, 80);
    const type = mapServiceType(desc, s?.service_type);
    let cost = num(s?.cost);
    cost = cost != null && cost >= 0 && cost < 1_000_000 ? Math.round(cost * 100) / 100 : null;
    const prev = seen.get(type);
    if (prev) { // one line per service type (the form has one checkbox each); costs add up
      if (cost != null) prev.cost = Math.round(((prev.cost || 0) + cost) * 100) / 100;
      if (type === 'other' && desc && prev.label && !prev.label.includes(desc) && prev.label.length + desc.length < 78) prev.label += `, ${desc}`;
      continue;
    }
    seen.set(type, { type, label: type === 'other' ? (desc || 'Other') : null, cost });
  }
  return {
    isInvoice: r.is_invoice !== false,
    date, odometer, total,
    vendor: clip(r.vendor, 120),
    services: [...seen.values()],
    text: typeof r.text === 'string' ? r.text.replace(/[ \t]+/g, ' ').trim().slice(0, 20000) : '',
  };
}

// Scan result -> Log service form state (MaintenanceSection's shape). Fields the scan didn't read stay as the form had them.
export function invoiceToForm(inv, base) {
  const f = { ...base, checked: { ...(base?.checked || {}) }, costs: { ...(base?.costs || {}) } };
  if (inv?.date) f.serviceDate = inv.date;
  if (inv?.odometer != null) f.odometer = String(inv.odometer);
  if (inv?.vendor) f.vendor = inv.vendor;
  if (inv?.total != null) f.totalCost = inv.total.toFixed(2);
  for (const s of inv?.services || []) {
    f.checked[s.type] = true;
    if (s.cost != null) f.costs[s.type] = s.cost.toFixed(2);
    if (s.type === 'other' && s.label) f.otherLabel = s.label.slice(0, 80);
  }
  return f;
}

// Search words shown as chips / used for highlighting; mirrors maint_vault_list (whitespace split, max 200 chars).
export const searchWords = (q) => String(q || '').slice(0, 200).toLowerCase().split(/\s+/).filter(Boolean);

// Form values -> maint_vault_save arguments. Blank -> null. Throws a user message on bad input.
export function saveArgs(id, v = {}) {
  const t = (x) => (x == null ? '' : String(x)).trim();
  const date = t(v.date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Enter the date as a date.');
  const total = t(v.total).replace(/[$,\s]/g, '');
  if (total && !(Number.isFinite(+total) && +total >= 0 && +total < 1e8)) throw new Error('Enter the total as an amount.');
  const odo = t(v.odometer).replace(/[,\s]/g, '');
  if (odo && !/^\d{1,7}$/.test(odo)) throw new Error('Enter the miles as a whole number.');
  return {
    p_doc: id, p_vendor: t(v.vendor).slice(0, 120) || null, p_date: date || null, p_total: total ? Math.round(+total * 100) / 100 : null,
    p_odometer: odo ? +odo : null, p_notes: t(v.notes).slice(0, 1000) || null,
    p_text: typeof v.text === 'string' && v.text.trim() ? v.text.slice(0, 20000) : null, p_scanned: !!v.scanned,
  };
}

