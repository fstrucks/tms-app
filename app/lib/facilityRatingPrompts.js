// Facility rating prompts: pure rules (no I/O). Plan: facility-rating-prompt-plan.md, with Sam's review changes.
export const RECENT_REVIEW_DAYS = 30;
export const FALLBACK_TZ = 'America/Chicago';
export const REMIND_HOUR = 9;
export const PROMPT_KINDS = ['pickup', 'delivery'];
export const OPEN_STATUSES = ['pending', 'skipped', 'reminded'];
export const PROMPT_ACTIONS = ['skip', 'shown', 'dismiss', 'dismiss_facility'];

// Only the assigned driver, or the owner on his own load when nobody is assigned. Never staff / dispatchers.
export function shouldPromptUser(load, userId) {
  if (!load || !userId) return false;
  if (load.assigned_driver_user_id) return load.assigned_driver_user_id === userId;
  return load.user_id === userId;
}

export function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export const tzOr = (tz) => (validTz(tz) ? tz : FALLBACK_TZ);

// YYYY-MM-DD of an instant in a zone.
export function localDate(ts, tz) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tzOr(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function parts(d, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(d)) p[x.type] = Number(x.value);
  return p;
}
// Instant of a wall-clock time in a zone (DST-safe: iterate the offset).
export function zonedToUtc(y, m, d, h, min, tz) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(t), tz);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (got === want) break;
    t += want - got;
  }
  return new Date(t);
}

// 9:00 the next local day in the stop's zone.
export function remindAtFor(now, tz) {
  const z = tzOr(tz);
  const p = parts(now instanceof Date ? now : new Date(now), z);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), REMIND_HOUR, 0, z);
}

// Reminder card state for a prompt row at `now`:
//  'first'  due and never shown -> show, then POST 'shown' (status reminded)
//  'again'  shown earlier the SAME local day (row timezone) -> keep showing on reloads
//  null     hidden (not due yet, answered, or shown on an earlier day: never returns)
export function cardState(row, now = new Date()) {
  if (!row) return null;
  const t = now instanceof Date ? now : new Date(now);
  if (row.status === 'pending' || row.status === 'skipped') {
    if (row.reminded_at) return null;
    return new Date(row.remind_at).getTime() <= t.getTime() ? 'first' : null;
  }
  if (row.status === 'reminded' && row.reminded_at) {
    return localDate(row.reminded_at, row.timezone) === localDate(t, row.timezone) ? 'again' : null;
  }
  return null;
}

export const recentSince = (now = new Date()) => new Date((now instanceof Date ? now : new Date(now)).getTime() - RECENT_REVIEW_DAYS * 86400000);
