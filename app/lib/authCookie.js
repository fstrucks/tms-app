// Session cookie for routes a signed-in user may open directly in a browser tab (no Authorization header there).
// The app keeps its Supabase session in localStorage, so no auth cookie existed before; AppNav mirrors the current
// access token into this cookie on every auth event and clears it on sign-out.
//  * Path=/api/dispatch: only sent to the dispatch API routes, nowhere else on the site.
//  * SameSite=Lax + Secure on https; expires with the access token.
//  * The server never trusts it on its own: it's used exactly like a Bearer token (PostgREST verifies the JWT and
//    the database decides the role), and a Bearer header always wins.
export const AUTH_COOKIE = 'ph_dispatch_at';
export const AUTH_COOKIE_PATH = '/api/dispatch';

// Browser: → the Set-Cookie string to assign to document.cookie (pure, so it can be tested).
export function authCookieString(session, { now = Date.now(), https = true } = {}) {
  const tail = `; Path=${AUTH_COOKIE_PATH}; SameSite=Lax${https ? '; Secure' : ''}`;
  const token = session?.access_token;
  const maxAge = session?.expires_at ? Math.floor(session.expires_at - now / 1000) : 3600;
  if (!token || maxAge <= 0) return `${AUTH_COOKIE}=; Max-Age=0${tail}`;
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}${tail}`;
}
export function syncAuthCookie(session) {
  if (typeof document === 'undefined') return;
  try { document.cookie = authCookieString(session, { https: window.location.protocol === 'https:' }); } catch { /* ignore */ }
}

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
