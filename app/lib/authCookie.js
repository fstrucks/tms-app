// Session cookie for routes a signed-in user may open directly in a browser tab (no Authorization header there).
// The app keeps its Supabase session in localStorage, so no auth cookie existed before.
//  * Set and cleared ONLY by the server (POST / DELETE /api/dispatch/session): the cookie is HttpOnly, so page
//    scripts can't read it (follow-up to #94). AppNav asks the server to set it on every auth event that carries a
//    new token and to clear it on sign-out.
//  * The server sets it only after Supabase Auth has verified the Bearer token it was sent; the token's own expiry
//    sets Max-Age.
//  * Path=/api/dispatch: only sent to the dispatch API routes, nowhere else on the site.
//  * SameSite=Lax + Secure on https.
//  * Routes never trust it on its own: it's used exactly like a Bearer token (PostgREST verifies the JWT and the
//    database decides the role on every request), and a Bearer header always wins.
export const AUTH_COOKIE = 'ph_dispatch_at';
export const AUTH_COOKIE_PATH = '/api/dispatch';
export const AUTH_SESSION_URL = '/api/dispatch/session';
export const AUTH_COOKIE_MAX_S = 24 * 3600; // never longer than a day, whatever the token says

// Server: → the Set-Cookie header value (pure, so it can be tested). session = { access_token, expires_at (s) }.
export function authCookieString(session, { now = Date.now(), https = true } = {}) {
  const tail = `; Path=${AUTH_COOKIE_PATH}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
  const token = session?.access_token;
  const maxAge = session?.expires_at ? Math.min(AUTH_COOKIE_MAX_S, Math.floor(session.expires_at - now / 1000)) : 3600;
  if (!token || maxAge <= 0) return `${AUTH_COOKIE}=; Max-Age=0${tail}`;
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}${tail}`;
}

// Browser: ask the server to set (session with a token) or clear (no session) the cookie. Skips repeat calls for
// the same token; a failed set is retried on the next auth event. Page scripts never write the cookie.
let lastSynced; // undefined = never synced in this tab; '' = cleared; otherwise the token last set
// Calls run one at a time, in order, so a slow "set" can never land after the sign-out "clear".
let chain = Promise.resolve();
export function syncAuthCookie(session, opts = {}) {
  const p = chain.then(() => syncOnce(session, opts));
  chain = p.catch(() => {});
  return p;
}
async function syncOnce(session, { fetchImpl = typeof fetch === 'undefined' ? null : fetch } = {}) {
  if (typeof window === 'undefined' || !fetchImpl) return false;
  const token = session?.access_token || '';
  if (token === lastSynced) return true;
  lastSynced = token;
  let ok = false;
  try {
    const res = await fetchImpl(AUTH_SESSION_URL, token
      ? { method: 'POST', headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin', cache: 'no-store' }
      : { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
    ok = !!res?.ok;
  } catch { ok = false; }
  if (!ok && lastSynced === token) lastSynced = undefined; // try again on the next auth event
  return ok;
}
export const resetAuthCookieSync = () => { lastSynced = undefined; };

// Server: the token from this cookie, or null.
export function cookieToken(req) {
  const raw = req?.headers?.get?.('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === AUTH_COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) || null; } catch { return null; }
    }
  }
  return null;
}

// Server: is the request https? (Vercel terminates TLS and forwards x-forwarded-proto.)
export function isHttps(req) {
  const xf = String(req?.headers?.get?.('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (xf) return xf === 'https';
  try { return new URL(req.url).protocol === 'https:'; } catch { return true; }
}

// Server: refuse cross-site calls (the Bearer header already forces a CORS preflight that this app never allows;
// this is a second check). Missing headers (older browsers, server-side tests) are allowed.
export function sameOrigin(req) {
  const site = req?.headers?.get?.('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const origin = req?.headers?.get?.('origin');
  if (!origin) return true;
  try {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host;
    return new URL(origin).host === host;
  } catch { return false; }
}
