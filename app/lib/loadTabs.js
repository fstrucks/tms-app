// Loads page tabs (option A). Pure helpers: no React/DOM. Unit-tested in tests/js/loadTabs.test.mjs.
export const TABS = [
  { id: 'active', label: 'Active', statuses: ['dispatched', 'in_transit'], dateBy: 'pickup', newestFirst: false },
  { id: 'pending', label: 'Pending', statuses: ['delivered', 'invoiced'], dateBy: 'delivery', newestFirst: true },
  { id: 'booked', label: 'Booked', statuses: ['booked'], dateBy: 'pickup', newestFirst: false },
  { id: 'past', label: 'Past', statuses: ['paid', 'cancelled'], dateBy: 'delivery', newestFirst: true },
];
export const DEFAULT_TAB = 'active';

// Unknown / missing statuses land in Active so nothing disappears.
export function tabFor(status) {
  return (TABS.find((t) => t.statuses.includes(status)) || TABS[0]).id;
}

export const parseTab = (v) => (TABS.some((t) => t.id === v) ? v : DEFAULT_TAB);

export function countByTab(loads) {
  const c = Object.fromEntries(TABS.map((t) => [t.id, 0]));
  for (const l of loads || []) c[tabFor(l.status)] += 1;
  return c;
}

export const sortedStops = (l) => [...(l?.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

const isPickup = (s) => s?.stop_type !== 'delivery';
export function pickupStop(l) { const st = sortedStops(l); return st.find(isPickup) || st[0] || null; }
export function deliveryStop(l) { const st = sortedStops(l); return [...st].reverse().find((s) => s?.stop_type !== 'pickup') || st[st.length - 1] || null; }

// YYYY-MM-DD of a timestamp in the stop's zone (browser zone if missing/invalid).
export function dayKey(ts, tz) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let f;
  try { f = new Intl.DateTimeFormat('en-CA', tz ? { ...opts, timeZone: tz } : opts); } catch { f = new Intl.DateTimeFormat('en-CA', opts); }
  return f.format(d);
}

function loadDay(l, dateBy) {
  const s = dateBy === 'delivery' ? deliveryStop(l) : pickupStop(l);
  return { key: dayKey(s?.appointment_start, s?.timezone), at: s?.appointment_start ? Date.parse(s.appointment_start) : NaN };
}

// Groups the tab's loads by day: [{ key: 'YYYY-MM-DD' | null, loads: [...] }].
// Active/Booked: pickup date, soonest first. Pending/Past: delivery date, newest first. Undated last.
export function groupLoads(loads, tabId) {
  const tab = TABS.find((t) => t.id === tabId) || TABS[0];
  const dir = tab.newestFirst ? -1 : 1;
  const rows = (loads || []).filter((l) => tabFor(l.status) === tab.id).map((l) => ({ l, ...loadDay(l, tab.dateBy) }));
  rows.sort((a, b) => {
    if (a.key === null || b.key === null) return (a.key === null) - (b.key === null);
    if (a.at !== b.at) return dir * (a.at - b.at);
    return Date.parse(b.l.created_at || 0) - Date.parse(a.l.created_at || 0);
  });
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && g.key === r.key) g.loads.push(r.l); else groups.push({ key: r.key, loads: [r.l] });
  }
  return groups;
}

// Header label for a group key, e.g. "Today", "Tomorrow", "Mon, Oct 12" (year added if not this year).
export function groupLabel(key, now = new Date()) {
  if (!key) return 'No date';
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

// The load for the "on the road" bar: in_transit, soonest pickup first.
export function currentInTransit(loads) {
  const g = groupLoads((loads || []).filter((l) => l.status === 'in_transit'), 'active');
  return g[0]?.loads[0] || null;
}
