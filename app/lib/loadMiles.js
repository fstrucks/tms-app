// PR A (Marc, Oct 18): trip miles read from the rate con → loads.total_miles ("planned" miles).
//  * A typed value always wins: rate con miles only ever fill an EMPTY total_miles (create + re-run), like weight.
//  * loads.miles_source ('typed' | 'rate_con' | 'calculated'; calculated is set by PR B) is added by 20261018000300_load_miles_source.sql. Until that migration
//    runs, every write retries without the column, and the source note is inferred (see milesSourceNote).
//  * Marc's decision (Oct 18, "I like seeing both"): Planned and Actual side by side. Actual = mileage log sum;
//    after the migration it never overwrites
//    planned/typed miles. Before it, the old 0600 trigger still copies the log total into total_miles.

export const MIN_TRIP_MILES = 1;
export const MAX_TRIP_MILES = 6000; // a single US load; anything larger is a misread

// "1,270 mi" | "626" | 626 | 314.4 → whole miles; null when missing or not a plausible trip.
export function parseTripMiles(v) {
  if (v == null || v === '') return null;
  let n;
  if (typeof v === 'number') n = v;
  else {
    const m = String(v).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    n = Number(m[0]);
  }
  if (!Number.isFinite(n)) return null;
  n = Math.round(n);
  return n >= MIN_TRIP_MILES && n <= MAX_TRIP_MILES ? n : null;
}

// Miles to copy from a rate con's ai_extracted_data (older reads have no total_miles → null).
export const extractedMiles = (x) => parseTripMiles(x?.total_miles ?? null);

export const MILES_SOURCE_COL = 'miles_source';
const MISSING_COL = new Set(['42703', 'PGRST204']);
export const isMissingMilesSource = (error) => !!error && (MISSING_COL.has(error.code) || /Could not find the|does not exist/i.test(error.message || '')) && String(error.message || '').includes(MILES_SOURCE_COL);

// Has the migration run? A `select('*')` row carries the key once the column exists.
export const hasMilesSourceColumn = (row) => !!row && Object.prototype.hasOwnProperty.call(row, MILES_SOURCE_COL);

// update loads set total_miles = miles, miles_source = source [where total_miles is null]. Retries without
// miles_source when the column isn't there yet. Never throws. Returns { data, error, migrated }.
export async function writeLoadMiles(db, { loadId, userId = null, miles, source, onlyIfEmpty = false, select = 'id, total_miles, rate_per_mile' }) {
  const run = async (patch) => {
    let q = db.from('loads').update(patch).eq('id', loadId);
    if (userId) q = q.eq('user_id', userId);
    if (onlyIfEmpty) q = q.is('total_miles', null);
    return q.select(select);
  };
  try {
    const patch = { total_miles: miles, [MILES_SOURCE_COL]: miles == null ? null : source };
    let r = await run(patch);
    if (r.error && isMissingMilesSource(r.error)) {
      r = await run({ total_miles: miles });
      return { data: r.data, error: r.error, migrated: false };
    }
    return { data: r.data, error: r.error, migrated: !r.error };
  } catch (error) { return { data: null, error, migrated: false }; }
}

// Create-from-document and re-run: fill planned miles from the rate con. Precedence (Marc, Oct 18):
// typed > rate con > calculated route miles (PR B). So it fills an EMPTY total_miles, or replaces one whose
// miles_source is 'calculated'. Never overwrites typed or earlier rate con miles.
export async function fillLinkedLoadMiles(db, { loadId, userId, miles }) {
  const mi = parseTripMiles(miles);
  if (!loadId) return { filled: false, skipped: 'no_linked_load' };
  if (!mi) return { filled: false, skipped: 'no_miles' };
  const r = await writeLoadMiles(db, { loadId, userId, miles: mi, source: 'rate_con', onlyIfEmpty: true, select: 'id' });
  if (r.error) return { filled: false, error: r.error };
  if (r.data?.length) return { filled: true, miles: mi };
  if (r.migrated) {
    try {
      let q = db.from('loads').update({ total_miles: mi, [MILES_SOURCE_COL]: 'rate_con' }).eq('id', loadId);
      if (userId) q = q.eq('user_id', userId);
      const c = await q.eq(MILES_SOURCE_COL, 'calculated').select('id');
      if (!c.error && c.data?.length) return { filled: true, miles: mi, replaced: 'calculated' };
    } catch {}
  }
  return { filled: false, skipped: 'kept_existing' };
}

// Small grey note under Miles. load.miles_source wins; otherwise (before the migration, or loads saved before it)
// it's inferred: equal to the mileage-log total → the old (pre-migration) trigger copied it; equal to the rate con → rate con;
// anything else was typed.
export function milesSourceNote({ load, rateConMiles = null, loggedTotal = 0 }) {
  const tm = load?.total_miles;
  if (tm == null || tm === '') return null;
  const src = load?.[MILES_SOURCE_COL];
  if (src === 'rate_con') return 'from rate con';
  if (src === 'typed') return 'typed';
  if (src === 'calculated') return 'calculated route miles';
  const n = Number(tm);
  if (loggedTotal > 0 && n === Number(loggedTotal)) return 'from mileage log';
  if (rateConMiles != null && n === Number(rateConMiles)) return 'from rate con';
  return 'typed';
}
