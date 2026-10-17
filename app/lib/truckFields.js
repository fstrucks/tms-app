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
