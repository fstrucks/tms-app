// Load boards (dispatch center, phase 1): the boards we open, and saving a load found on one.
// ALL board names and URLs live here so they're easy to change. Phase 1 has no board APIs: the buttons open the
// board's own site in a new tab, and "Save a load from a board" creates a PowerHaul load by hand.
// Source board: stored as the FIRST LINE of loads.notes ("Load board: DAT One"). No new column (no SQL); a
// dedicated column can come later.

export const LOAD_BOARDS = [
  { key: 'dat', label: 'DAT One', url: 'https://one.dat.com' },
  { key: 'truckstop', label: 'Truckstop', url: 'https://app.truckstop.com' },
  { key: 'uber', label: 'Uber Freight', url: 'https://www.uberfreight.com/en-US/login' },
  { key: 'freightlink', label: 'Freight Link (FreightLink Solutions, unconfirmed)', url: 'https://freightlinksolutions.net' },
];
export const OTHER_BOARD = 'other';
// Header link row: owners can't use /dispatch (staff only), so Loads goes to /loads for them.
export const loadsLinkHref = (role) => (role === 'owner' ? '/loads' : '/dispatch');

export const BOARD_PREFIX = 'Load board: ';

export const boardLabel = (key, other = '') => (key === OTHER_BOARD ? String(other || '').trim() : LOAD_BOARDS.find((b) => b.key === key)?.label || '');
export const boardNoteLine = (label) => `${BOARD_PREFIX}${String(label || '').trim()}`;

// notes → { board: 'DAT One' | null, rest: notes without the board line }
export function boardFromNotes(notes) {
  const text = String(notes || '');
  const [first, ...more] = text.split('\n');
  if (!first.startsWith(BOARD_PREFIX)) return { board: null, rest: text };
  return { board: first.slice(BOARD_PREFIX.length).trim() || null, rest: more.join('\n') };
}
export const notesWithBoard = (label, notes) => {
  const n = String(notes || '').trim();
  return n ? `${boardNoteLine(label)}\n${n}` : boardNoteLine(label);
};

export const EMPTY_BOARD_FORM = { board: '', board_other: '', broker_name: '', broker_load_number: '', rate: '', commodity: '', weight: '', equipment_type: '', miles: '', notes: '' };

const num = (v) => { const t = String(v ?? '').replace(/[$,\s]/g, ''); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const txt = (v) => { const t = String(v ?? '').trim(); return t || null; };

// → { errors, load } (load null when there are errors). Stops are validated separately by formToStops (lib/dispatch).
export function buildBoardLoad(form, { userId } = {}) {
  const f = { ...EMPTY_BOARD_FORM, ...(form || {}) };
  const errors = {};
  const label = boardLabel(f.board, f.board_other);
  if (!f.board) errors.board = 'Pick the load board.';
  else if (!label) errors.board_other = 'Type the board name.';
  else if (label.length > 80) errors.board_other = 'Keep the board name under 80 characters.';
  if (!txt(f.broker_name)) errors.broker_name = 'Enter the broker.';
  const rate = num(f.rate), weight = num(f.weight), miles = num(f.miles);
  if (rate === null) errors.rate = 'Enter the rate, like 1,280.';
  else if (Number.isNaN(rate) || rate < 0) errors.rate = 'Enter the rate as a number, like 1,280.';
  if (Number.isNaN(weight) || (weight !== null && weight <= 0)) errors.weight = 'Enter the weight in pounds, like 38,500, or leave it empty.';
  if (Number.isNaN(miles) || (miles !== null && miles <= 0)) errors.miles = 'Enter miles as a number, like 327, or leave it empty.';
  if (String(f.notes || '').length > 3900) errors.notes = 'Keep notes under 3,900 characters.';
  if (Object.keys(errors).length) return { errors, load: null };
  const load = {
    user_id: userId, status: 'booked',
    broker_name: txt(f.broker_name), broker_load_number: txt(f.broker_load_number), rate,
    commodity: txt(f.commodity), weight: weight === null ? null : Math.round(weight), equipment_type: txt(f.equipment_type),
    notes: notesWithBoard(label, f.notes),
  };
  if (miles !== null) { load.total_miles = miles; load.miles_source = 'typed'; }
  return { errors, load };
}

// Owner only (phase 1): insert the load under the owner's RLS, then save its stops with dispatch_save_stops.
// If the stops fail, the half-made load is deleted again. → { ok, id } | { ok: false, error }
export async function createBoardLoad(supabase, { load, stops }, { saveStops }) {
  const { data: row, error } = await supabase.from('loads').insert(load).select('id').single();
  if (error || !row?.id) {
    if (error && /miles_source/.test(error.message || '') && 'miles_source' in load) {
      const { miles_source, ...rest } = load; // eslint-disable-line no-unused-vars
      return createBoardLoad(supabase, { load: rest, stops }, { saveStops });
    }
    return { ok: false, error: 'Couldn’t save the load. Please try again.', cause: error };
  }
  const st = await saveStops(supabase, row.id, stops);
  if (!st.ok) {
    await supabase.from('loads').delete().eq('id', row.id);
    return { ok: false, error: `${st.error} The load was not saved.`, cause: st.cause };
  }
  return { ok: true, id: row.id };
}

// Loads that came from a board (first line of notes), newest first.
export const boardLoads = (loads = []) => loads
  .map((l) => ({ ...l, board: boardFromNotes(l.notes).board }))
  .filter((l) => l.board)
  .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
