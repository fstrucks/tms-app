// Preventive maintenance schedules (migration 20261023000300). Pure helpers shared by the route, the pages and tests.
// The database works out next due and status (pm_status_for); this file shapes input and labels only.
import { SERVICE_TYPES } from './maintenance.js';

export const DUTY_CYCLES = [
  ['long_haul', 'Long haul', 'Mostly highway, long runs'],
  ['short_haul', 'Short haul / regional', 'Local or regional, more stops'],
  ['severe', 'Severe', 'Heavy loads, lots of idling, off-road or stop-and-go'],
  ['unknown', 'Not sure', 'We use the shorter intervals'],
];
const DUTY_SET = new Set(DUTY_CYCLES.map(([k]) => k));
export const STATUS_LABEL = { overdue: 'Overdue', due: 'Due', due_soon: 'Due soon', unknown: 'Unknown', ok: 'OK' };
export const STATUS_RANK = { overdue: 0, due: 1, due_soon: 2, unknown: 3, ok: 4 };
export const NOT_SURE = 'not_sure';
const TYPE_SET = new Set(SERVICE_TYPES.map(([k]) => k));
export const engineKey = (e) => (e ? `${e.maker}|${e.model}` : NOT_SURE);
export const engineLabel = (maker, model) => (model ? `${maker ? `${maker} ` : ''}${model}` : 'Not sure');

const mdy = (d) => (d ? `${String(d).slice(5, 7)}/${String(d).slice(8, 10)}/${String(d).slice(0, 4)}` : '');
// "Suggested from <source>, as of <date>" | "General estimate" | "Custom interval"
export function sourceText(row) {
  if (!row) return '';
  if (row.source === 'custom') return 'Custom interval';
  if (row.is_generic) return 'General estimate';
  return `Suggested from ${row.source_title || 'the engine maker'}${row.as_of_date ? `, as of ${mdy(row.as_of_date)}` : ''}`;
}
export function intervalText(row) {
  const parts = [];
  if (row?.interval_miles) parts.push(`${Number(row.interval_miles).toLocaleString('en-US')} mi`);
  if (row?.interval_days) parts.push(row.interval_days % 365 === 0 ? `${row.interval_days / 365} yr` : row.interval_days % 30 === 0 ? `${row.interval_days / 30} mo` : `${row.interval_days} days`);
  return parts.length ? `Every ${parts.join(' or ')}${parts.length > 1 ? ', whichever first' : ''}` : 'No set interval';
}
export function dueText(row) {
  if (!row) return '';
  if (row.status === 'due') return 'Not done yet';
  if (row.status === 'unknown') return row.last_done_date ? 'No interval set' : 'No record yet';
  const bits = [];
  if (row.miles_left != null) bits.push(row.miles_left < 0 ? `${Math.abs(row.miles_left).toLocaleString('en-US')} mi over` : `${row.miles_left.toLocaleString('en-US')} mi left`);
  if (row.days_left != null) bits.push(row.days_left < 0 ? `${Math.abs(row.days_left)} days over` : `${row.days_left} days left`);
  return bits.join(' · ');
}

const int = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isInteger(n) ? n : NaN;
};

// Truck fields from the setup form → { patch } | { error }. engine = 'maker|model' from pm_engine_choices, or 'not_sure'.
export function engineInput(v = {}, engines = []) {
  const key = String(v.engine || '');
  if (!key) return { error: 'Pick the engine model, or “Not sure”.' };
  let engine_make = null, engine_model = null;
  if (key !== NOT_SURE) {
    const e = engines.find((x) => engineKey(x) === key);
    if (!e) return { error: 'Pick the engine model from the list.' };
    engine_make = e.maker; engine_model = e.model;
  }
  const duty = String(v.dutyCycle || 'unknown');
  if (!DUTY_SET.has(duty)) return { error: 'Pick how the truck is used.' };
  const year = int(v.engineYear);
  if (Number.isNaN(year) || (year != null && (year < 1980 || year > 2100))) return { error: 'Engine year must be a 4-digit year.' };
  let mpg = null;
  if (v.mpg !== '' && v.mpg != null) {
    mpg = Number(String(v.mpg).trim());
    if (!Number.isFinite(mpg) || mpg < 1 || mpg > 20) return { error: 'MPG should be between 1 and 20.' };
    mpg = Math.round(mpg * 10) / 10;
  }
  return { patch: { engine_make, engine_model, engine_year: year, duty_cycle: duty, mpg } };
}

// Checklist → baseline visits + start states.
// items: [{ serviceType, done, date, dateUnknown, miles, milesUnknown }]
// Done with a date → a baseline visit (one per distinct date + miles; normally just one). Done but date unknown → 'unknown'.
// Not done → 'due'. Only the owner records baseline visits; for anyone else done items start as 'unknown'.
export function checklistInput(items = [], { role = 'owner', today, odometer = null } = {}) {
  const groups = new Map(), start = {};
  for (const it of Array.isArray(items) ? items : []) {
    const t = it?.serviceType;
    if (!TYPE_SET.has(t) || t === 'other') return { error: 'Unknown service in the checklist.' };
    if (!it.done) { start[t] = 'due'; continue; }
    if (role !== 'owner' || it.dateUnknown) { start[t] = 'unknown'; continue; }
    const date = String(it.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: 'Pick a date for each checked service, or “Not sure”.' };
    if (today && date > today) return { error: 'A service date can’t be in the future.' };
    const miles = it.milesUnknown ? null : int(it.miles);
    if (Number.isNaN(miles) || (miles != null && (miles < 0 || miles > 9999999))) return { error: 'Miles must be a whole number.' };
    if (miles != null && odometer != null && miles > odometer) return { error: 'A service can’t be at more miles than the truck has now.' };
    const k = `${date}|${miles ?? ''}`;
    if (!groups.has(k)) groups.set(k, { service_date: date, odometer: miles, items: [] });
    groups.get(k).items.push(t);
  }
  return { baseline: [...groups.values()], start };
}

// Checklist order for "Log service": overdue, due, due soon, unknown, OK, then services with no schedule (list order).
export function orderBySchedule(types = SERVICE_TYPES, schedule = []) {
  const by = new Map((schedule || []).map((r) => [r.service_type, r]));
  const base = types.map(([k], i) => [k, i]);
  const rank = (k) => (by.has(k) ? STATUS_RANK[by.get(k).status] ?? 5 : 6);
  const order = base.sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([k]) => k);
  return order.map((k) => {
    const [, label] = types.find(([x]) => x === k);
    const r = by.get(k);
    return { key: k, label, status: r?.status || null, isDue: !!r && ['overdue', 'due', 'due_soon'].includes(r.status) };
  });
}

// Schedule edit → { interval_miles, interval_days } | { error }. Blank = not used; at least one is needed.
export function intervalInput(v = {}) {
  const miles = int(v.intervalMiles), days = int(v.intervalDays);
  if (Number.isNaN(miles) || (miles != null && (miles < 1 || miles > 2000000))) return { error: 'Miles must be a whole number.' };
  if (Number.isNaN(days) || (days != null && (days < 1 || days > 3650))) return { error: 'Days must be a whole number up to 3650.' };
  if (miles == null && days == null) return { error: 'Enter miles, days, or both.' };
  return { interval_miles: miles, interval_days: days };
}

// NHTSA vPIC DecodeVinValues → fields to pre-fill. The user confirms before anything is saved.
export const VPIC_URL = (vin) => `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
const ENGINE_MAKERS = [['detroit', 'Detroit'], ['cummins', 'Cummins'], ['paccar', 'PACCAR'], ['volvo', 'Volvo'], ['mack', 'Mack'], ['navistar', 'International'], ['international', 'International']];
export function decodeVin(body, engines = []) {
  const r = body?.Results?.[0];
  if (!r) return { error: 'The VIN lookup didn’t return anything.' };
  const clean = (x) => { const t = String(x ?? '').trim(); return t && t !== 'Not Applicable' ? t : null; };
  const year = Number(clean(r.ModelYear)) || null;
  const out = { make: clean(r.Make), model: clean(r.Model), year, engineMake: null, engineModel: clean(r.EngineModel), engine: null };
  const em = `${clean(r.EngineManufacturer) || ''} ${clean(r.EngineModel) || ''}`.toLowerCase();
  out.engineMake = ENGINE_MAKERS.find(([k]) => em.includes(k))?.[1] || clean(r.EngineManufacturer);
  // Match a known engine: same maker and the model's base name (e.g. "DD15", "X15", "MX-13") in the decoded text.
  const flat = em.replace(/[\s-]/g, '');
  const hits = engines.filter((e) => e.maker === out.engineMake && flat.includes(e.model.split(' (')[0].toLowerCase().replace(/[\s-]/g, '')));
  if (hits.length) out.engine = engineKey(hits.sort((a, b) => b.model.localeCompare(a.model))[0]);
  if (!out.make && !out.model && !out.year) return { error: clean(r.ErrorText) ? 'That VIN didn’t decode. Check it and try again.' : 'The VIN lookup didn’t return anything.' };
  return out;
}

export const badgeStyle = (status) => {
  const tone = status === 'overdue' ? ['var(--danger)', 'var(--danger-bg, transparent)'] : ['due', 'due_soon'].includes(status) ? ['var(--warning)', 'var(--warning-bg)'] : status === 'ok' ? ['var(--success)', 'transparent'] : ['var(--text-muted)', 'transparent'];
  return { fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, border: `1px solid ${tone[0]}`, color: tone[0], background: tone[1], whiteSpace: 'nowrap' };
};
