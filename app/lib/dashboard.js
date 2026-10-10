import { EXPENSE_CATEGORIES } from './expenses';

// Which loads count as revenue: 'non_cancelled' (default) or 'completed_only'.
export const REVENUE_RULE = 'non_cancelled';
export const EXCLUDED_STATUSES = ['cancelled', 'canceled', 'tonu', 'void'];
export const COMPLETED_STATUSES = ['delivered', 'invoiced', 'paid'];

const norm = (s) => (s || '').trim().toLowerCase();
export function countsAsRevenue(status) {
  const st = norm(status);
  if (EXCLUDED_STATUSES.includes(st)) return false;
  return REVENUE_RULE === 'completed_only' ? COMPLETED_STATUSES.includes(st) : true;
}

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PAGE = 1000;
const MAX_ROWS = 10000;

// Fetch all rows for a query factory, 1000 at a time (capped).
export async function fetchPaged(make) {
  const out = [];
  // Keep fetching until a page comes back short or empty; stop at the safety cap.
  while (out.length < MAX_ROWS) {
    const { data, error } = await make().range(out.length, out.length + PAGE - 1);
    if (error) throw error;
    const page = data || [];
    out.push(...page);
    if (page.length < PAGE) return { rows: out, truncated: false };
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
  ...w, revenue: 0, loads: 0, missingRate: 0, rpmRate: 0, rpmMiles: 0,
  miles: { loaded: 0, deadhead: 0, personal: 0, other: 0 },
  expenses: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])), expenseTotal: 0,
});

export function aggregate(weeks, { loads, entries, expenses }) {
  const rows = weeks.map(emptyWeek);
  const today = localISO(new Date());
  const find = (date) => (date ? rows.find((w) => date >= w.start && date < w.end) : null);

  for (const l of loads) {
    if (!countsAsRevenue(l.status)) continue;
    const w = find(loadDate(l));
    if (!w) continue;
    w.loads += 1;
    const hasRate = l.rate !== null && l.rate !== undefined && l.rate !== '';
    if (!hasRate) { w.missingRate += 1; continue; }
    const rate = Number(l.rate) || 0;
    w.revenue += rate;
    const tm = Number(l.total_miles);
    if (tm > 0) { w.rpmRate += rate; w.rpmMiles += tm; }
  }
  for (const e of entries) {
    if (!e.entry_date || e.entry_date > today) continue; // future-dated entries excluded
    const w = find(parseDate(e.entry_date));
    const m = Number(e.miles);
    if (!w || !(m > 0)) continue;
    const src = ['loaded', 'deadhead', 'personal'].includes(e.source) ? e.source : 'other';
    w.miles[src] += m;
  }
  for (const x of expenses) {
    if (!x.expense_date || x.expense_date > today) continue;
    const w = find(parseDate(x.expense_date));
    if (!w) continue;
    const amt = Number(x.amount) || 0;
    const cat = x.category || 'other';
    w.expenses[cat] = (w.expenses[cat] || 0) + amt; // unknown legacy categories kept as-is
    w.expenseTotal += amt;
  }
  return rows.map((w) => finish(roundWeek(w)));
}

// Round money to cents per week (before any period totals are summed).
function roundWeek(w) {
  return {
    ...w,
    revenue: r2(w.revenue),
    rpmRate: r2(w.rpmRate),
    expenseTotal: r2(w.expenseTotal),
    expenses: Object.fromEntries(Object.entries(w.expenses).map(([k, v]) => [k, r2(v)])),
  };
}

function finish(w) {
  const rpm = (num, m) => (m > 0 ? r2(num / m) : null);
  return {
    ...w,
    totalMiles: w.miles.loaded + w.miles.deadhead + w.miles.personal + w.miles.other,
    // Loaded RPM: loads with both rate and total_miles > 0 (load miles, not logged miles).
    loadedRpm: rpm(w.rpmRate, w.rpmMiles),
    // All-in RPM: revenue over logged loaded + deadhead miles.
    allInRpm: rpm(w.revenue, w.miles.loaded + w.miles.deadhead),
    net: r2(w.revenue - w.expenseTotal),
  };
}

export function summarize(rows) {
  if (!rows.length) return null;
  const s = emptyWeek({ start: rows[0].start, end: rows[rows.length - 1].end, key: 'total' });
  for (const w of rows) {
    s.revenue += w.revenue; s.loads += w.loads; s.expenseTotal += w.expenseTotal;
    s.missingRate += w.missingRate; s.rpmRate += w.rpmRate; s.rpmMiles += w.rpmMiles;
    for (const k of Object.keys(w.miles)) s.miles[k] += w.miles[k];
    for (const [k, v] of Object.entries(w.expenses)) s.expenses[k] = (s.expenses[k] || 0) + v;
  }
  // Week values are already rounded; re-round sums to drop float noise.
  return finish(roundWeek(s));
}
