// Truck maintenance log (migration 20261023000100). Pure helpers shared by the route, the page and tests.
// One visit (service_records) = date, miles, vendor, total cost, receipts, optional load; its items are the services done.

// Order = checklist order. Must match service_record_items_type_check in the migration.
export const SERVICE_TYPES = [
  ['oil_filter', 'Oil & filter'], ['fuel_filters', 'Fuel filters'], ['air_filter', 'Air filter'], ['coolant', 'Coolant'],
  ['def_filter', 'DEF filter'], ['valve_adjustment', 'Valve adjustment'], ['transmission', 'Transmission service'],
  ['differential', 'Differential service'], ['tires', 'Tires'], ['brakes', 'Brakes'], ['grease', 'Grease / chassis lube'],
  ['dot_annual', 'DOT annual inspection'], ['other', 'Other'],
];
const TYPE_SET = new Set(SERVICE_TYPES.map(([k]) => k));
export const typeLabel = (item) => (item?.service_type === 'other' && item.service_label ? item.service_label : (SERVICE_TYPES.find(([k]) => k === item?.service_type)?.[1] || 'Service'));
export const BASELINE_LABEL = 'Starting point (entered by owner)';
export const MAX_RECEIPTS = 10;
export const canLogService = (role) => ['owner', 'management', 'driver'].includes(role);
export const isOffice = (role) => role === 'owner' || role === 'management';
// Mirrors maint_can_change in SQL (RLS is the real check): office always; a driver his own entry within 24 h.
export function canChangeVisit(role, userId, rec, now = Date.now()) {
  if (isOffice(role)) return true;
  return role === 'driver' && !!rec && rec.created_by === userId && now - new Date(rec.created_at).getTime() < 24 * 3600e3;
}

const money = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 1e8 ? Math.round(n * 100) / 100 : NaN;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t ? t.slice(0, n) : null; };

// Form values → { visit, items } | { error }. role decides whether a baseline is allowed.
export function visitInput(v = {}, { role = 'owner', today = new Date().toISOString().slice(0, 10) } = {}) {
  const baseline = v.entrySource === 'baseline';
  if (baseline && role !== 'owner') return { error: 'Only the company owner can enter a starting point.' };
  const date = String(v.serviceDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: 'Pick the service date.' };
  if (date > today) return { error: 'The service date can’t be in the future.' };
  let odometer = null;
  if (v.odometer !== '' && v.odometer != null) {
    odometer = Number(String(v.odometer).replace(/[,\s]/g, ''));
    if (!Number.isInteger(odometer) || odometer < 0 || odometer > 9999999) return { error: 'Miles must be a whole number.' };
  }
  const total = money(v.totalCost);
  if (Number.isNaN(total)) return { error: 'Enter the cost as a dollar amount.' };
  const raw = Array.isArray(v.items) ? v.items : [];
  const items = [];
  for (const it of raw) {
    if (!TYPE_SET.has(it?.serviceType)) return { error: 'Pick a service from the list.' };
    const cost = money(it.cost);
    if (Number.isNaN(cost)) return { error: 'Enter item costs as dollar amounts.' };
    const label = it.serviceType === 'other' ? clip(it.label, 80) : null;
    if (it.serviceType === 'other' && !label) return { error: 'Say what the “Other” service was.' };
    if (items.some((x) => x.service_type === it.serviceType && it.serviceType !== 'other')) continue;
    items.push({ service_type: it.serviceType, service_label: label, cost, notes: clip(it.notes, 300) });
  }
  if (!items.length) return { error: 'Check at least one service.' };
  if (items.length > 30) return { error: 'Too many services on one visit.' };
  const itemSum = items.reduce((a, x) => a + (x.cost || 0), 0);
  const totalCost = total ?? Math.round(itemSum * 100) / 100; // blank total → sum of item costs
  const addToExpenses = !baseline && v.addToExpenses !== false;
  const loadId = addToExpenses && UUID.test(v.loadId || '') ? v.loadId : null;
  return {
    visit: { service_date: date, odometer, vendor_name: clip(v.vendor, 120), total_cost: totalCost, notes: clip(v.notes, 1000),
      add_to_expenses: addToExpenses, load_id: loadId, entry_source: baseline ? 'baseline' : 'logged' },
    items,
  };
}

// Rows → history, newest first, each visit with its items and receipts.
export function shapeHistory(records = [], items = [], docs = []) {
  const byRec = new Map();
  for (const it of items) (byRec.get(it.service_record_id) || byRec.set(it.service_record_id, []).get(it.service_record_id)).push(it);
  const order = SERVICE_TYPES.map(([k]) => k);
  return [...records]
    .sort((a, b) => (b.service_date || '').localeCompare(a.service_date || '') || (b.created_at || '').localeCompare(a.created_at || ''))
    .map((r) => ({
      ...r,
      baseline: r.entry_source === 'baseline',
      items: (byRec.get(r.id) || []).sort((a, b) => order.indexOf(a.service_type) - order.indexOf(b.service_type)),
      receipts: docs.filter((d) => d.service_record_id === r.id),
    }));
}
export const fmtMiles = (n) => (n == null ? '' : `${Number(n).toLocaleString('en-US')} mi`);
export const fmtMoney = (n) => (n == null ? '' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
