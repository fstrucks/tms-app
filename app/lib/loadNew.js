// Manual "New load" (/loads/new). Before this, /loads/new fell through to /loads/[id] with id = "new":
// the page queried loads.id = 'new' (not a UUID) and never showed a load, so testers were stuck on "Loading load…".
// Now /loads/new is its own static route (Next.js matches it before [id]) and [id] rejects non-UUID ids up front.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isLoadId = (id) => typeof id === 'string' && UUID_RE.test(id);

export const EMPTY_NEW_LOAD = {
  broker_name: '', broker_load_number: '', rate: '', miles: '', commodity: '', weight: '', equipment_type: '',
  pu_company: '', pu_address: '', pu_city: '', pu_state: '', pu_zip: '', pu_appt: '',
  del_company: '', del_address: '', del_city: '', del_state: '', del_zip: '', del_appt: '',
};

const num = (v) => {
  const t = String(v ?? '').replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const txt = (v) => { const t = String(v ?? '').trim(); return t || null; };

// datetime-local value ("2026-10-20T08:00") -> ISO string in the browser's zone; '' -> null; bad -> NaN marker.
function appt(v) {
  const t = txt(v);
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d) ? 'bad' : d.toISOString();
}

// Returns { errors: {field: message}, load, stops }. load/stops are null when there are errors.
export function buildNewLoad(form, { userId, timezone = null } = {}) {
  const f = { ...EMPTY_NEW_LOAD, ...(form || {}) };
  const errors = {};
  const rate = num(f.rate);
  const miles = num(f.miles);
  const weight = num(f.weight);
  if (rate === null) errors.rate = 'Enter the rate, like 1,280.';
  else if (Number.isNaN(rate) || rate < 0) errors.rate = 'Enter the rate as a number, like 1,280.';
  if (Number.isNaN(miles) || (miles !== null && miles <= 0)) errors.miles = 'Enter miles as a number, like 327, or leave it empty.';
  if (Number.isNaN(weight) || (weight !== null && weight <= 0)) errors.weight = 'Enter the weight in pounds, like 38,500, or leave it empty.';
  for (const [p, label] of [['pu', 'pickup'], ['del', 'delivery']]) {
    if (!txt(f[`${p}_city`])) errors[`${p}_city`] = `Enter the ${label} city.`;
    const st = txt(f[`${p}_state`]);
    if (!st) errors[`${p}_state`] = `Enter the ${label} state.`;
    else if (!/^[A-Za-z]{2}$/.test(st)) errors[`${p}_state`] = 'Use the 2-letter state, like CA.';
    const zip = txt(f[`${p}_zip`]);
    if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) errors[`${p}_zip`] = 'Use a 5-digit ZIP, like 91761.';
    if (appt(f[`${p}_appt`]) === 'bad') errors[`${p}_appt`] = 'Pick a valid date and time.';
  }
  if (Object.keys(errors).length) return { errors, load: null, stops: null };

  const load = {
    user_id: userId,
    status: 'booked',
    broker_name: txt(f.broker_name),
    broker_load_number: txt(f.broker_load_number),
    rate,
    commodity: txt(f.commodity),
    weight: weight === null ? null : Math.round(weight),
    equipment_type: txt(f.equipment_type),
  };
  // Typed miles win over rate con and calculated miles (PR #82 order). Empty: the map card calculates them.
  if (miles !== null) { load.total_miles = miles; load.miles_source = 'typed'; }
  const stop = (p, kind, sequence) => ({
    stop_type: kind, sequence,
    company_name: txt(f[`${p}_company`]),
    address_line1: txt(f[`${p}_address`]),
    city: txt(f[`${p}_city`]),
    state: txt(f[`${p}_state`]).toUpperCase(),
    zip: txt(f[`${p}_zip`]),
    appointment_start: appt(f[`${p}_appt`]),
    timezone: appt(f[`${p}_appt`]) ? timezone : null,
  });
  return { errors, load, stops: [stop('pu', 'pickup', 1), stop('del', 'delivery', 2)] };
}

// Inserts the load, then its two stops. If the stops fail, the half-made load is removed again.
// Returns { ok: true, id } or { ok: false, error }.
export async function createManualLoad(supabase, built) {
  const { data: row, error } = await supabase.from('loads').insert(built.load).select('*').single();
  if (error || !row?.id) {
    // miles_source missing (20261018000300 not applied): retry once without it rather than failing.
    if (error && /miles_source/.test(error.message || '') && 'miles_source' in built.load) {
      const { miles_source, ...rest } = built.load; // eslint-disable-line no-unused-vars
      return createManualLoad(supabase, { ...built, load: rest });
    }
    return { ok: false, error: "Couldn't create the load. Please try again.", cause: error };
  }
  const { data: stops, error: se } = await supabase.from('stops').insert(built.stops.map((s) => ({ ...s, load_id: row.id }))).select('*');
  if (se) {
    await supabase.from('loads').delete().eq('id', row.id);
    return { ok: false, error: "Couldn't save the pickup and delivery. The load was not created. Please try again.", cause: se };
  }
  // load: the saved row + stops, handed to the load page so it can show at once (see loadSeed.js).
  const sorted = [...(stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return { ok: true, id: row.id, load: { ...row, stops: sorted } };
}
