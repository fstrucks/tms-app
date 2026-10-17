// Truck tab field keys ↔ existing DB columns. Keys match the packet field names from PR #67
// (app/lib/packetFieldNames.js EXTRA_KEYS) so packets can auto-fill from the Truck tab later.
// Columns are NOT renamed: trucks.unit_number stays unit_number, etc. Pure module (no I/O).

export const TRUCK_FIELD_MAP = {
  driver_name: { table: 'drivers', column: 'name' },
  truck_number: { table: 'trucks', column: 'unit_number' },
  trailer_number: { table: 'trailers', column: 'unit_number' },
  truck_plate: { table: 'trucks', column: 'license_plate' },
  truck_plate_state: { table: 'trucks', column: 'license_state' },
  trailer_plate: { table: 'trailers', column: 'license_plate' },
  trailer_plate_state: { table: 'trailers', column: 'license_state' },
};
export const TRUCK_FIELD_KEYS = Object.keys(TRUCK_FIELD_MAP);
const STATE_KEYS = new Set(['truck_plate_state', 'trailer_plate_state']);

// { truck, trailer, driver } rows → { driver_name: 'Pat', truck_number: '104', ... } (missing → '').
export function fieldValuesFromRows({ truck = null, trailer = null, driver = null } = {}) {
  const rows = { trucks: truck, trailers: trailer, drivers: driver };
  const out = {};
  for (const [key, { table, column }] of Object.entries(TRUCK_FIELD_MAP)) {
    const v = rows[table]?.[column];
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

// Field values → column patch for ONE table. Unknown keys and keys for other tables are ignored.
// Plate states are upper-cased 2-letter codes; other values are trimmed. Empty → null.
export function columnsFromFieldValues(table, values = {}) {
  const patch = {};
  for (const [key, raw] of Object.entries(values || {})) {
    const m = TRUCK_FIELD_MAP[key];
    if (!m || m.table !== table) continue;
    let v = String(raw ?? '').trim();
    if (STATE_KEYS.has(key)) v = v.toUpperCase().slice(0, 2);
    patch[m.column] = v || null;
  }
  return patch;
}

// Latest scale reading: newest ticket_date, then newest created_at.
export function latestWeight(history = []) {
  return [...(history || [])].filter((h) => Number.isFinite(Number(h?.gross_weight_lb)))
    .sort((a, b) => String(b.ticket_date).localeCompare(String(a.ticket_date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}
export const GROSS_LIMIT_LB = 80000; // federal gross limit (open question (b): warn above this?)

// Expiry badge for CDL / med card, per docs/design/maintenance.md §6.1 ("expiry" kinds: no grace).
// Same thresholds as the planned shared dueStage() (SOON_DAYS 30, NEAR_DAYS 14); swap to it when maintenance.js lands.
export const SOON_DAYS = 30, NEAR_DAYS = 14;
export function expiryBadge(date, today) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!ok) return { stage: 'none', label: 'No date', tone: 'grey' };
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (d < 0) return { stage: 'expired', daysLeft: d, label: `EXPIRED ${-d} day${d === -1 ? '' : 's'}`, tone: 'red-strong' };
  if (d === 0) return { stage: 'today', daysLeft: 0, label: 'Expires today', tone: 'red' };
  if (d <= NEAR_DAYS) return { stage: 'near', daysLeft: d, label: d === 1 ? 'Expires tomorrow' : `Expires in ${d} days`, tone: 'orange' };
  if (d <= SOON_DAYS) return { stage: 'soon', daysLeft: d, label: `Expires in ${d} days`, tone: 'yellow' };
  return { stage: 'ok', daysLeft: d, label: 'OK', tone: 'green' };
}

// ---- Weight checks (Marc, Oct 17) ----
export const AXLE_LIMITS_LB = { steer_axle_lb: 12000, drive_axle_lb: 34000, trailer_axle_lb: 34000 };
const AXLE_NAMES = { steer_axle_lb: 'Steer axle', drive_axle_lb: 'Drive axle group', trailer_axle_lb: 'Trailer axle group' };
export const LOAD_DIFF_PCT = 10;
export const NET_TOLERANCE_LB = 500; // empty weigh-ins vary a few hundred lb; only flag a clearly negative net
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const lbs = (n) => `${Math.round(n).toLocaleString('en-US')} lb`;

// Net cargo = gross − (truck empty + trailer empty). Null unless gross and BOTH empty weights are known
// (a missing trailer empty weight would overstate cargo). Never negative-silently: a negative net is returned as is
// so the UI can say the empty weights look wrong.
export function netCargo(gross, truckEmpty, trailerEmpty) {
  const g = num(gross), t = num(truckEmpty), r = num(trailerEmpty);
  return g == null || t == null || r == null ? null : g - t - r;
}

// → { net, warnings: [{ code, text }] }. loadWeight = the linked rate con's load weight (loads.weight, lb).
// The rate con weight is cargo weight, so it is compared with NET cargo (needs both empty weights).
export function weightChecks({ ticket = {}, truckEmpty = null, trailerEmpty = null, loadWeight = null } = {}) {
  const warnings = [];
  const gross = num(ticket.gross_weight_lb);
  if (gross != null && gross > GROSS_LIMIT_LB) warnings.push({ code: 'gross_over', text: `Gross ${lbs(gross)} is over the ${lbs(GROSS_LIMIT_LB)} limit (by ${lbs(gross - GROSS_LIMIT_LB)}).` });
  for (const [k, limit] of Object.entries(AXLE_LIMITS_LB)) {
    const v = num(ticket[k]);
    if (v != null && v > limit) warnings.push({ code: `${k.replace('_lb', '')}_over`, text: `${AXLE_NAMES[k]} ${lbs(v)} is over ${lbs(limit)}.` });
  }
  const net = netCargo(gross, truckEmpty, trailerEmpty);
  if (net != null && net < -NET_TOLERANCE_LB) warnings.push({ code: 'net_negative', text: 'Net cargo is below zero. Check the truck and trailer empty weights.' });
  const lw = num(loadWeight);
  if (net != null && net > 0 && lw != null && lw > 0) {
    const pct = (Math.abs(net - lw) / lw) * 100;
    if (pct > LOAD_DIFF_PCT) warnings.push({ code: 'load_mismatch', text: `Net cargo ${lbs(net)} is ${Math.round(pct)}% ${net > lw ? 'over' : 'under'} the rate con weight (${lbs(lw)}).` });
  }
  return { net, warnings };
}

// ---- Roles: drivers get a read-only Truck tab ----
export const TRUCK_EDIT_ROLES = new Set(['owner', 'dispatcher', 'management']);
export const canEditTruck = (role) => TRUCK_EDIT_ROLES.has(role);

// ---- Input cleaning (server and client share these) ----
const clean = (v, max = 80) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return s || null; };
const state2 = (v) => { const s = String(v ?? '').trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : null; };
const intIn = (v, lo, hi) => { const n = num(String(v ?? '').replace(/[,\s]|lbs?\.?$/gi, '')); return n == null ? null : Math.round(n) >= lo && Math.round(n) <= hi ? Math.round(n) : NaN; };
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : null);
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

// → { patch } | { error }. Field keys go through TRUCK_FIELD_MAP; extra columns are whitelisted here.
export function truckInput(v = {}) {
  const patch = columnsFromFieldValues('trucks', v);
  if (!patch.unit_number) return { error: 'Enter a truck number.' };
  if (String(v.truck_plate_state ?? '').trim() && !state2(v.truck_plate_state)) return { error: 'Plate state is a 2-letter code, like CA.' };
  const vin = clean(v.vin, 17)?.toUpperCase() || null;
  if (vin && !VIN.test(vin)) return { error: 'A VIN is 17 letters and numbers (no I, O or Q).' };
  const ew = intIn(v.truck_empty_weight_lb, 0, 100000);
  if (Number.isNaN(ew)) return { error: 'Truck empty weight must be 0 to 100,000 lb.' };
  return { patch: { ...patch, unit_number: clean(patch.unit_number, 20), license_plate: clean(patch.license_plate, 12), vin, empty_weight_lb: ew } };
}
export function trailerInput(v = {}) {
  const patch = columnsFromFieldValues('trailers', v);
  if (!patch.unit_number) return { error: 'Enter a trailer number.' };
  if (String(v.trailer_plate_state ?? '').trim() && !state2(v.trailer_plate_state)) return { error: 'Plate state is a 2-letter code, like CA.' };
  const ew = intIn(v.trailer_empty_weight_lb, 0, 100000);
  if (Number.isNaN(ew)) return { error: 'Trailer empty weight must be 0 to 100,000 lb.' };
  return { patch: { ...patch, unit_number: clean(patch.unit_number, 20), license_plate: clean(patch.license_plate, 12), empty_weight_lb: ew } };
}
export function driverInput(v = {}) {
  const name = clean(v.driver_name, 120);
  if (!name) return { error: 'Enter the driver’s name.' };
  if (v.cdl_state && !state2(v.cdl_state)) return { error: 'CDL state is a 2-letter code, like CA.' };
  for (const k of ['cdl_expiry', 'med_card_expiry']) if (v[k] && !isoDate(v[k])) return { error: 'Pick a valid date.' };
  return { patch: { name, phone: clean(v.phone, 30), cdl_number: clean(v.cdl_number, 30), cdl_state: state2(v.cdl_state), cdl_expiry: isoDate(v.cdl_expiry), med_card_expiry: isoDate(v.med_card_expiry) } };
}
export function ticketInput(v = {}) {
  const date = isoDate(v.ticket_date);
  if (!date) return { error: 'Enter the ticket date.' };
  const gross = intIn(v.gross_weight_lb, 1000, 200000);
  if (gross == null || Number.isNaN(gross)) return { error: 'Gross weight must be 1,000 to 200,000 lb.' };
  const out = { ticket_date: date, gross_weight_lb: gross, scale_name: clean(v.scale_name, 120) };
  for (const k of Object.keys(AXLE_LIMITS_LB)) {
    const a = intIn(v[k], 0, 100000);
    if (Number.isNaN(a)) return { error: 'Axle weights must be 0 to 100,000 lb.' };
    out[k] = a;
  }
  return { patch: out };
}

// AI scale-ticket result → ticket fields (weights as integers; "78,420 LB" → 78420).
export function normalizeScaleTicket(r = {}) {
  const w = (x) => { const n = intIn(x, 0, 200000); return Number.isNaN(n) ? null : n; };
  return {
    is_scale_ticket: r?.is_scale_ticket === true,
    ticket_date: isoDate(r?.ticket_date),
    gross_weight_lb: w(r?.gross_weight_lb),
    steer_axle_lb: w(r?.steer_axle_lb), drive_axle_lb: w(r?.drive_axle_lb), trailer_axle_lb: w(r?.trailer_axle_lb),
    scale_name: clean(r?.scale_name, 120),
  };
}
