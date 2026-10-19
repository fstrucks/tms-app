// Dispatch center (Marc approved, via Sam, Oct 18 2026): the owner's loads for management and dispatchers.
// Reads and writes go ONLY through the SECURITY DEFINER functions in migration 20261018000700 (dispatch_context,
// dispatch_loads, dispatch_update_load, dispatch_save_stops); own-row RLS on loads/stops is unchanged, so these
// users can't touch the tables directly. The database checks the role on every call; the checks here only shape
// the UI. Pure helpers + thin RPC wrappers, unit-tested in tests/js/dispatch.test.mjs.
import { isMissingFunction } from './homeCurrentLoad';
// Same list as lib/loads STATUSES (that module re-exports a JSX component, so it can't load in node tests).
export const STATUSES = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled'];

export const DISPATCH_ROLES = new Set(['management', 'dispatcher']);
export const RATECON_ROLES = new Set(['owner', 'management', 'dispatcher']);
export const SETUP_MSG = 'The dispatch center needs a database update that hasn’t been applied yet.';

const ERRORS = {
  load_not_found: 'Load not found.',
  not_allowed: 'Only management and dispatchers can change loads here.',
  bad_status: 'Pick a valid status.',
  bad_number: 'Rate, miles and weight must be numbers.',
  bad_rate: 'Enter the rate, like 1,280.',
  bad_miles: 'Miles must be more than 0, or leave them empty.',
  bad_weight: 'Weight must be more than 0, or leave it empty.',
  bad_patch: 'One of the fields is too long or invalid.',
  bad_stops: 'The stops changed on another screen. Reload the load and try again.',
  bad_stop_type: 'Each stop must be a pickup or a delivery.',
  missing_pickup: 'A load needs at least one pickup.',
  missing_delivery: 'A load needs at least one delivery.',
  stop_city_required: 'Every stop needs a city.',
  bad_state: 'Use the 2-letter state, like CA.',
  assigned_driver_not_driver: 'That person is not a driver on the company anymore. Pick another driver.',
};
export function errorText(error, fallback = 'Couldn’t save. Please try again.') {
  const msg = String(error?.message || '');
  const k = Object.keys(ERRORS).find((c) => msg.includes(c));
  return k ? ERRORS[k] : fallback;
}

const rows = (data) => (data || []).map((r) => (r && r.dispatch_loads) || r);

// → { setup: true } | { error } | { companies: [{ owner_id, role, company_name }] }
export async function fetchDispatchContext(supabase) {
  const { data, error } = await supabase.rpc('dispatch_context');
  if (error) return isMissingFunction(error) ? { setup: true } : { error };
  return { companies: data || [] };
}
export async function fetchDispatchLoads(supabase, loadId = null) {
  const { data, error } = await supabase.rpc('dispatch_loads', loadId ? { p_load: loadId } : {});
  if (error) return isMissingFunction(error) ? { setup: true } : { error };
  return { loads: rows(data) };
}

// ---------- Load form ----------
export const LOAD_TEXT_FIELDS = ['broker_name', 'broker_load_number', 'commodity', 'equipment_type', 'special_instructions', 'notes'];
const s = (v) => (v == null ? '' : String(v));
export function loadToForm(l = {}) {
  return {
    status: s(l.status) || 'booked', broker_name: s(l.broker_name), broker_load_number: s(l.broker_load_number),
    rate: s(l.rate), total_miles: s(l.total_miles), weight: s(l.weight), commodity: s(l.commodity), equipment_type: s(l.equipment_type),
    special_instructions: s(l.special_instructions), notes: s(l.notes),
    assigned_driver_user_id: s(l.assigned_driver_user_id), show_rate_to_driver: l.show_rate_to_driver === true,
  };
}
const num = (v) => { const t = String(v ?? '').replace(/[$,\s]/g, ''); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };

// Only changed keys go to the server. → { errors, patch }
export function formToPatch(form, original) {
  const f = { ...loadToForm(), ...(form || {}) }, o = loadToForm(original || {});
  const errors = {}, patch = {};
  const rate = num(f.rate), miles = num(f.total_miles), weight = num(f.weight);
  if (rate === null || Number.isNaN(rate) || rate < 0) errors.rate = 'Enter the rate, like 1,280.';
  if (Number.isNaN(miles) || (miles !== null && miles <= 0)) errors.total_miles = 'Enter miles as a number, like 327, or leave it empty.';
  if (Number.isNaN(weight) || (weight !== null && weight <= 0)) errors.weight = 'Enter the weight in pounds, like 38,500, or leave it empty.';
  if (!STATUSES.includes(f.status)) errors.status = 'Pick a status.';
  for (const k of LOAD_TEXT_FIELDS) if (f[k].length > 4000) errors[k] = 'Keep this under 4,000 characters.';
  if (Object.keys(errors).length) return { errors, patch: null };
  if (f.status !== o.status) patch.status = f.status;
  for (const k of LOAD_TEXT_FIELDS) if (f[k].trim() !== o[k].trim()) patch[k] = f[k].trim() || null;
  if (rate !== num(o.rate)) patch.rate = rate;
  if (miles !== num(o.total_miles)) patch.total_miles = miles;
  if (weight !== num(o.weight)) patch.weight = weight === null ? null : Math.round(weight);
  if ((f.assigned_driver_user_id || '') !== (o.assigned_driver_user_id || '')) patch.assigned_driver_user_id = f.assigned_driver_user_id || null;
  if (f.show_rate_to_driver !== o.show_rate_to_driver) patch.show_rate_to_driver = f.show_rate_to_driver;
  return { errors, patch };
}

// Money words in notes: drivers keep seeing notes, so the page warns before a pay amount reaches them.
export const PAY_IN_NOTES = /\$\s?\d|\b(rate|pay|paid|linehaul|line haul|rpm|per mile|all[- ]in)\b/i;
export const notesMayShowPay = (notes) => PAY_IN_NOTES.test(String(notes || ''));

// ---------- Stops form ----------
export const STOP_FIELDS = ['stop_type', 'company_name', 'address_line1', 'city', 'state', 'zip', 'appointment_start', 'appointment_end', 'timezone', 'pickup_number', 'notes'];
let tmp = 0;
const newKey = () => `new-${++tmp}`;

// datetime-local text in the stop's own zone ↔ ISO. Falls back to the browser zone when the zone is missing/invalid.
function zoneParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const validTz = (tz) => { if (!tz) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
export function isoToLocal(iso, tz) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  if (validTz(tz)) return zoneParts(ms, tz);
  const d = new Date(ms), pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localToIso(local, tz) {
  const t = String(local || '').trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t);
  if (!m) return 'bad';
  if (!validTz(tz)) { const d = new Date(t); return Number.isNaN(d.getTime()) ? 'bad' : d.toISOString(); }
  // Wall time in tz → UTC: guess as UTC, then correct by the zone offset (twice, for DST edges).
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = want;
  for (let i = 0; i < 2; i++) {
    const [y, mo, d, h, mi] = zoneParts(ms, tz).split(/[-T:]/).map(Number);
    ms += want - Date.UTC(y, mo - 1, d, h, mi);
  }
  return new Date(ms).toISOString();
}

export function stopsToForm(stops = []) {
  return [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((x) => ({
    key: x.id != null ? `id-${x.id}` : newKey(), id: x.id ?? null,
    stop_type: x.stop_type === 'delivery' ? 'delivery' : 'pickup', company_name: s(x.company_name), address_line1: s(x.address_line1),
    city: s(x.city), state: s(x.state), zip: s(x.zip), timezone: s(x.timezone),
    appointment_start: isoToLocal(x.appointment_start, x.timezone), appointment_end: isoToLocal(x.appointment_end, x.timezone),
    pickup_number: s(x.pickup_number), notes: s(x.notes),
  }));
}
export const blankStop = (stop_type = 'delivery', timezone = '') => ({ key: newKey(), id: null, stop_type, company_name: '', address_line1: '', city: '', state: '', zip: '', timezone, appointment_start: '', appointment_end: '', pickup_number: '', notes: '' });

// + Add pickup goes before the first delivery (pickups first); + Add delivery appends. No delivery yet → append.
export function addStop(list, stop_type, timezone = '') {
  const row = blankStop(stop_type, timezone);
  const l = list || [];
  if (stop_type !== 'pickup') return [...l, row];
  const i = l.findIndex((x) => x.stop_type === 'delivery');
  return i < 0 ? [...l, row] : [...l.slice(0, i), row, ...l.slice(i)];
}

export function moveStop(list, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const out = [...list]; [out[i], out[j]] = [out[j], out[i]]; return out;
}

// → { errors: { [key]: { field: msg } , _list?: msg }, payload }
export function formToStops(list, { browserTz = null } = {}) {
  const errors = {};
  const payload = [];
  if (!list?.length || list.length < 2) errors._list = 'A load needs at least one pickup and one delivery.';
  else if (!list.some((x) => x.stop_type === 'pickup')) errors._list = 'A load needs at least one pickup.';
  else if (!list.some((x) => x.stop_type === 'delivery')) errors._list = 'A load needs at least one delivery.';
  if ((list || []).length > 20) errors._list = 'A load can have up to 20 stops.';
  for (const x of list || []) {
    const e = {};
    const tz = x.timezone || browserTz || null;
    if (!x.city.trim()) e.city = 'Enter the city.';
    if (x.state.trim() && !/^[A-Za-z]{2}$/.test(x.state.trim())) e.state = 'Use the 2-letter state, like CA.';
    if (x.zip.trim() && !/^\d{5}(-\d{4})?$/.test(x.zip.trim())) e.zip = 'Use a 5-digit ZIP, like 91761.';
    const a = localToIso(x.appointment_start, tz), b = localToIso(x.appointment_end, tz);
    if (a === 'bad') e.appointment_start = 'Pick a valid date and time.';
    if (b === 'bad') e.appointment_end = 'Pick a valid date and time.';
    if (a && b && a !== 'bad' && b !== 'bad' && Date.parse(b) < Date.parse(a)) e.appointment_end = 'The window ends before it starts.';
    if (x.pickup_number.length > 80) e.pickup_number = 'Keep this under 80 characters.';
    if (Object.keys(e).length) errors[x.key] = e;
    const item = {
      stop_type: x.stop_type, company_name: x.company_name.trim() || null, address_line1: x.address_line1.trim() || null,
      city: x.city.trim(), state: x.state.trim().toUpperCase() || null, zip: x.zip.trim() || null,
      appointment_start: a === 'bad' ? null : a, appointment_end: b === 'bad' ? null : b,
      timezone: (a || b) ? tz : (x.timezone || null),
      pickup_number: x.stop_type === 'pickup' ? (x.pickup_number.trim() || null) : null, notes: x.notes.trim() || null,
    };
    if (x.id != null) item.id = String(x.id);
    payload.push(item);
  }
  return { errors, payload: Object.keys(errors).length ? null : payload };
}

export async function saveLoad(supabase, loadId, patch) {
  const { data, error } = await supabase.rpc('dispatch_update_load', { p_load: loadId, p_patch: patch });
  return error ? { ok: false, error: errorText(error), cause: error } : { ok: true, load: data };
}
export async function saveStops(supabase, loadId, payload) {
  const { data, error } = await supabase.rpc('dispatch_save_stops', { p_load: loadId, p_stops: payload });
  return error ? { ok: false, error: errorText(error, 'Couldn’t save the stops. Please try again.'), cause: error } : { ok: true, stops: data || [] };
}

// Rate con through the server route (role checked there). → { url } | { error }
export async function rateConUrl(supabase, loadId, fetchImpl = fetch) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) return { error: 'Your session has expired. Please sign in again.' };
  try {
    const r = await fetchImpl(`/api/dispatch/loads/${loadId}/ratecon`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const b = await r.json().catch(() => ({}));
    return r.ok && b.url ? { url: b.url } : { error: b.error || 'Couldn’t open the rate con. Please try again.' };
  } catch { return { error: 'Couldn’t open the rate con. Check your connection and try again.' }; }
}

export const driverMap = (choices = []) => Object.fromEntries(choices.map((c) => [c.user_id, c.email]));

// /dispatch for someone who isn't management / a dispatcher: say what applies to THEM. roles = the caller's own
// company_members roles (own rows are readable under the existing RLS). → { text, href, linkText }
export function notMemberCopy(roles = []) {
  const r = new Set(roles || []);
  if (r.has('owner')) return { text: 'The dispatch center is for your management and dispatchers. You manage your loads on', href: '/loads', linkText: 'Loads' };
  if (r.has('driver')) return { text: 'Your dispatcher manages loads. Your current load is on', href: '/', linkText: 'Home' };
  return { text: 'The dispatch center is for a company’s management and dispatchers. Ask the company owner for access, or go to', href: '/', linkText: 'Home' };
}
export async function fetchMyRoles(supabase) {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const uid = sess?.session?.user?.id;
    if (!uid) return [];
    const { data, error } = await supabase.from('company_members').select('role').eq('user_id', uid);
    return error ? [] : (data || []).map((m) => m.role);
  } catch { return []; }
}

// ---------- New load (management / dispatcher; migration 20261019000100) ----------
// public.dispatch_create_load(p_owner, p_load, p_stops) creates the load under the company OWNER's account
// (loads.user_id = owner) with its stops in one transaction, and returns the new id. The database checks the role.
ERRORS.not_signed_in = 'Your session has expired. Please sign in again.';
export const CREATE_SETUP_MSG = 'Creating loads here needs a database update that hasn’t been applied yet.';
export const NEW_LOAD_KEYS = ['status', ...LOAD_TEXT_FIELDS, 'rate', 'total_miles', 'weight', 'assigned_driver_user_id', 'show_rate_to_driver'];

// New-load form → { errors, load } (same checks as the edit form; empty fields are left out).
export function formToNewLoad(form) {
  const { errors, patch } = formToPatch({ ...loadToForm(), ...(form || {}) }, {});
  if (!patch) return { errors, load: null };
  const load = { status: (form && form.status) || 'booked' };
  for (const k of NEW_LOAD_KEYS) if (k in patch && patch[k] !== null && patch[k] !== '') load[k] = patch[k];
  if (!load.assigned_driver_user_id) load.show_rate_to_driver = false;
  return { errors, load };
}

// → { ok, id } | { ok: false, error, setup? }
export async function createLoad(supabase, ownerId, load, stops) {
  const clean = Object.fromEntries(Object.entries(load || {}).filter(([k]) => NEW_LOAD_KEYS.includes(k)));
  const { data, error } = await supabase.rpc('dispatch_create_load', { p_owner: ownerId, p_load: clean, p_stops: stops });
  if (error) {
    if (isMissingFunction(error)) return { ok: false, setup: true, error: CREATE_SETUP_MSG, cause: error };
    return { ok: false, error: errorText(error, 'Couldn’t save the load. Please try again.'), cause: error };
  }
  const id = (data && data.dispatch_create_load) || data;
  return id ? { ok: true, id: String(id) } : { ok: false, error: 'Couldn’t save the load. Please try again.' };
}
