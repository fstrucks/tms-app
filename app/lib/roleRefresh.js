// Role-dependent chrome (the Dispatch tab in the Loads slot, the owner-only account menu items) right after sign-in.
// QA (Oct 19): straight after signing in, dispatchers saw "Loads" instead of "Dispatch" and the owner's menu lacked
// Invite testers and Bug reports until a reload. The first role check ran before the new session was usable: an RPC
// sent without the user's token goes out with the anon key and dispatch_context() answers [] with no error, which
// looked like a definite "not a dispatcher"; a dropped connection had the same effect, and nothing checked again.
// Now: a check only counts when the session in the client belongs to the signed-in user; "couldn't tell" keeps the
// last value and is retried on a short schedule; every auth change (sign-in, user switch, sign-out) re-checks; and the
// last definite answer per user is remembered for the tab so a reload doesn't flash the wrong tab.
import { isMissingFunction } from './homeCurrentLoad.js';
import { rpcWithRetry } from './dispatch.js';

export const ROLE_RETRY_MS = [400, 1200, 3000, 8000];
export const ROLE_CACHE_KEY = 'ph_nav_role';

// Is the client's current session the given user's? (false while the session is missing / still loading / another user)
export async function sessionIsFor(supabase, userId) {
  if (!supabase || !userId) return false;
  try {
    const { data } = await supabase.auth.getSession();
    const s = data?.session;
    return !!s?.access_token && s.user?.id === userId;
  } catch { return false; }
}

// → { definite: boolean, dispatcher: boolean }
export async function dispatcherStatus(supabase, userId, opts) {
  if (!(await sessionIsFor(supabase, userId))) return { definite: false, dispatcher: false };
  const { data, error } = await rpcWithRetry(supabase, 'dispatch_context', undefined, opts);
  if (error) return isMissingFunction(error) ? { definite: true, dispatcher: false } : { definite: false, dispatcher: false };
  // The session may have switched users while the call was in flight.
  if (!(await sessionIsFor(supabase, userId))) return { definite: false, dispatcher: false };
  return { definite: true, dispatcher: Array.isArray(data) && data.length > 0 };
}

// Auth events that must re-run role checks. TOKEN_REFRESHED only when the last check couldn't tell.
export function shouldRecheck(event, { userChanged = false, lastDefinite = true } = {}) {
  if (userChanged) return true;
  if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(event)) return true;
  return event === 'TOKEN_REFRESHED' && !lastDefinite;
}

// Run check() until it gives a definite answer or the schedule runs out. → cancel()
// check: async () => { definite, ... }; onResult(r) gets each definite answer; isLive() stops a stale run.
export function checkUntilDefinite(check, onResult, { schedule = ROLE_RETRY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let stopped = false, timer = null;
  const attempt = async (n) => {
    let r;
    try { r = await check(); } catch { r = { definite: false }; }
    if (stopped) return;
    if (r?.definite) { onResult(r); return; }
    if (n < schedule.length) timer = setTimer(() => attempt(n + 1), schedule[n]);
    else onResult({ ...r, definite: false, gaveUp: true });
  };
  attempt(0);
  return () => { stopped = true; if (timer) clearTimer(timer); };
}

// Per-tab memory of the last definite answer (no personal data: a user id and a boolean).
export function rememberRole(userId, dispatcher, store = typeof sessionStorage === 'undefined' ? null : sessionStorage) {
  try { if (store && userId) store.setItem(ROLE_CACHE_KEY, JSON.stringify({ u: userId, d: !!dispatcher })); } catch { /* ignore */ }
}
export function recallRole(userId, store = typeof sessionStorage === 'undefined' ? null : sessionStorage) {
  try {
    const v = store && userId ? JSON.parse(store.getItem(ROLE_CACHE_KEY) || 'null') : null;
    return v && v.u === userId ? !!v.d : null;
  } catch { return null; }
}
export function forgetRole(store = typeof sessionStorage === 'undefined' ? null : sessionStorage) {
  try { store?.removeItem(ROLE_CACHE_KEY); } catch { /* ignore */ }
}
