// Validate a ?next= redirect target. Only same-site paths are allowed: a single leading '/',
// not '//' or '/\', no scheme, no control chars, not /login itself. Anything else -> fallback.
export const DEFAULT_NEXT = '/documents';

export function safeNext(raw, fallback = DEFAULT_NEXT) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return fallback;
  // 1) Validate a decoded copy (up to 3 passes, so %5C, %255C, %09… are seen in final form).
  let v = raw;
  for (let i = 0; i < 3; i++) {
    let d;
    try { d = decodeURIComponent(v); } catch {
      if (i === 0) return fallback; // the raw value itself is malformed
      break; // a later pass hit a literal '%' (e.g. 100%25 -> 100%): nothing more can be hidden
    }
    if (d === v) break;
    v = d;
  }
  if (/[\u0000-\u001f\u007f]/.test(raw + v)) return fallback; // control chars, tabs, newlines
  if (raw.includes('\\') || v.includes('\\')) return fallback;   // any backslash, raw or encoded
  for (const x of [raw, v]) if (x[0] !== '/' || x[1] === '/') return fallback;
  // 2) Return the ORIGINAL (not the decoded copy) as normalized by URL, so %26/%25 survive.
  const origin = 'https://same.invalid';
  let u, dv;
  try { u = new URL(raw, origin); dv = new URL(v, origin); } catch { return fallback; }
  if (u.origin !== origin || dv.origin !== origin) return fallback;
  for (const p of [u.pathname, dv.pathname]) {
    if (p[1] === '/') return fallback; // e.g. '/..//evil.com' normalizes to '//evil.com'
    if (p === '/login' || p.startsWith('/login/')) return fallback;
  }
  return u.pathname + u.search + u.hash;
}

// /login?next=<current path+query>, for links shown to signed-out users.
export function loginHref(current) {
  const n = safeNext(current, '');
  return n ? `/login?next=${encodeURIComponent(n)}` : '/login';
}

// ---- ?next after sign-out (QA, Oct 19) ----
// Sign out sends you to /login?next=<the page you were on>. Before, whoever signed in next on that device landed on
// the previous person's page (a dispatcher's load, the owner's Team page…). Now sign-out remembers WHO it belonged to
// (a user id + the path, in this browser only, for 12 h) and the first sign-in afterwards keeps that ?next only for
// the same person; anyone else goes to the normal start page. A ?next that didn't come from a sign-out (a "Sign in"
// link on a signed-out page, an emailed link) is kept as before.
export const SIGNOUT_NEXT_KEY = 'ph_signout_next';
export const SIGNOUT_NEXT_TTL_MS = 12 * 3600 * 1000;
const defaultStore = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function rememberSignOutNext(userId, next, { store = defaultStore(), now = Date.now() } = {}) {
  try {
    if (!store) return;
    const n = safeNext(next, '');
    if (!userId || !n) { store.removeItem(SIGNOUT_NEXT_KEY); return; }
    store.setItem(SIGNOUT_NEXT_KEY, JSON.stringify({ u: userId, n, t: now }));
  } catch { /* ignore */ }
}

// → the path to open after a successful sign-in as userId. One-shot: the sign-out record is cleared.
export function nextAfterSignIn(rawNext, userId, { store = defaultStore(), now = Date.now(), fallback = DEFAULT_NEXT } = {}) {
  const n = safeNext(rawNext, fallback);
  let rec = null;
  try { rec = store ? JSON.parse(store.getItem(SIGNOUT_NEXT_KEY) || 'null') : null; store?.removeItem(SIGNOUT_NEXT_KEY); } catch { rec = null; }
  if (!rec || typeof rec !== 'object' || !rec.u || !rec.n) return n;
  if (!(now - Number(rec.t) <= SIGNOUT_NEXT_TTL_MS)) return n === rec.n ? fallback : n; // stale record: don't trust its next either
  if (n !== rec.n) return n;               // a different ?next than the one sign-out left
  return rec.u === userId ? n : fallback;  // same page: only for the person who signed out
}
