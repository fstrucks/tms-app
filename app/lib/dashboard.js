import { EXPENSE_CATEGORIES } from './expenses';

const PAGE = 1000;
const MAX_ROWS = 10000;

// Fetch all rows for a query factory, 1000 at a time (capped).
export async function fetchPaged(make) {
  const out = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

const pad = (n) => String(n).padStart(2, '0');
export const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

// Monday 00:00 local time of the week containing d.
export function weekStart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// The last n Monday-start weeks, oldest first, ending with the current week.
export function buildWeeks(n) {
  const cur = weekStart(new Date());
  return Array.from({ length: n }, (_, i) => {
    const start = new Date(cur); start.setDate(cur.getDate() - 7 * (n - 1 - i));
    const end = new Date(start); end.setDate(start.getDate() + 7);
    return { start, end, key: localISO(start) };
  });
}

// Week date for a load: delivery (last stop by sequence) appointment, else pickup (first stop), else created_at.
export function loadDate(load) {
  const stops = [...(load.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const ts = stops[stops.length - 1]?.appointment_start || stops[0]?.appointment_start || load.created_at;
  return ts ? new Date(ts) : null;
}

const emptyWeek = (w) => ({
  ...w, revenue: 0, loads: 0,
  miles: { loaded: 0, deadhead: 0, personal: 0, other: 0 },
  expenses: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])), expenseTotal: 0,
});

export function aggregate(weeks, { loads, entries, expenses }) {
  const rows = weeks.map(emptyWeek);
  const find = (date) => (date ? rows.find((w) => date >= w.start && date < w.end) : null);

  for (const l of loads) {
    if ((l.status || '').toLowerCase() === 'cancelled') continue;
    const w = find(loadDate(l));
    if (!w) continue;
    w.revenue += Number(l.rate) || 0;
    w.loads += 1;
  }
  for (const e of entries) {
    const w = e.entry_date && find(parseDate(e.entry_date));
    const m = Number(e.miles);
    if (!w || !(m > 0)) continue;
    const src = ['loaded', 'deadhead', 'personal'].includes(e.source) ? e.source : 'other';
    w.miles[src] += m;
  }
  for (const x of expenses) {
    const w = x.expense_date && find(parseDate(x.expense_date));
    if (!w) continue;
    const amt = Number(x.amount) || 0;
    const cat = x.category || 'other';
    w.expenses[cat] = (w.expenses[cat] || 0) + amt; // unknown legacy categories kept as-is
    w.expenseTotal += amt;
  }
  return rows.map(finish);
}

function finish(w) {
  const rpm = (m) => (m > 0 ? w.revenue / m : null);
  return {
    ...w,
    totalMiles: w.miles.loaded + w.miles.deadhead + w.miles.personal + w.miles.other,
    loadedRpm: rpm(w.miles.loaded),
    allInRpm: rpm(w.miles.loaded + w.miles.deadhead),
    net: w.revenue - w.expenseTotal,
  };
}

export function summarize(rows) {
  if (!rows.length) return null;
  const s = emptyWeek({ start: rows[0].start, end: rows[rows.length - 1].end, key: 'total' });
  for (const w of rows) {
    s.revenue += w.revenue; s.loads += w.loads; s.expenseTotal += w.expenseTotal;
    for (const k of Object.keys(w.miles)) s.miles[k] += w.miles[k];
    for (const [k, v] of Object.entries(w.expenses)) s.expenses[k] = (s.expenses[k] || 0) + v;
  }
  return finish(s);
}
