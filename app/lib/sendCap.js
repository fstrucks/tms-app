// Shared monthly email cap (Postmark plan: 100/month). Counts packet_sends + coi_requests rows whose sent_at
// falls in the current calendar month (America/Los_Angeles). Claimed-but-unconfirmed rows count too (conservative).
export const DEFAULT_MONTHLY_CAP = 80;
export const CAP_TABLES = ['packet_sends', 'coi_requests'];
const TZ = 'America/Los_Angeles';

export function monthlyCap(env = process.env) {
  const n = Number.parseInt(String(env.EMAIL_MONTHLY_CAP ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_CAP;
}

// Start of the current calendar month in Los Angeles, as an ISO UTC instant.
export function monthStartISO(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month);
  // LA offset at local midnight on the 1st: try -8h and -7h, keep the one that lands on the 1st 00:00 local.
  for (const off of [8, 7]) {
    const t = new Date(Date.UTC(y, m - 1, 1, off, 0, 0));
    const h = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(t);
    const hh = h.find((x) => x.type === 'hour').value, dd = h.find((x) => x.type === 'day').value;
    if (hh === '00' && dd === '01') return t.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, 1, 8)).toISOString();
}

const missing = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .* does not exist|Could not find the table/i.test(e.message || ''));

// → { used, cap, remaining, since } | { error }. A missing table (migration not applied) counts as 0 for that table.
export async function monthlyUsage(sb, env = process.env, now = new Date()) {
  const since = monthStartISO(now), cap = monthlyCap(env);
  let used = 0;
  for (const t of CAP_TABLES) {
    const r = await sb.from(t).select('id', { count: 'exact', head: true }).gte('sent_at', since);
    if (r.error) { if (missing(r.error)) continue; return { error: r.error }; }
    used += typeof r.count === 'number' ? r.count : (r.data || []).length;
  }
  return { used, cap, remaining: Math.max(0, cap - used), since };
}

export const capReached = (u) => !!u && !u.error && u.used >= u.cap;
export const capLabel = (u) => (u && !u.error && Number.isFinite(u.used) ? `${u.used} of ${u.cap} used this month` : '');
export const CAP_MSG = (u) => `This month’s email limit is reached (${u.used} of ${u.cap} used). Nothing was sent. It resets on the 1st.`;
