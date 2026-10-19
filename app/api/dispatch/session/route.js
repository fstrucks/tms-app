// POST   /api/dispatch/session  (Authorization: Bearer <access token>) → sets the HttpOnly ph_dispatch_at cookie
// DELETE /api/dispatch/session                                         → clears it (sign-out)
// The cookie lets dispatch routes opened directly in a tab (the rate con link) see who is signed in. See
// lib/authCookie for the rules. The token is verified with Supabase Auth BEFORE the cookie is set, and every route
// that reads the cookie verifies it again on every request (PostgREST + the database role check). The token is never
// echoed back or logged.
import { userClient, bearer, checkUser, jwtClaims, authErrInfo } from '../../../lib/packetServer';
import { authCookieString, isHttps, sameOrigin } from '../../../lib/authCookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const reply = (body, status, cookie) => {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
};

export async function POST(req, { deps } = {}) {
  const https = isHttps(req);
  const clear = authCookieString(null, { https });
  if (!sameOrigin(req)) return reply({ error: 'Not allowed.' }, 403);
  const token = bearer(req);
  if (!token) return reply({ error: 'Sign in first.' }, 401, clear);
  const uc = (deps?.mkUserClient || userClient)(token);
  const who = await checkUser(uc, token, deps?.authRetryMs != null ? { retryMs: deps.authRetryMs } : {});
  if (who.rejected) {
    if (who.error) console.warn('[dispatch session] token rejected', authErrInfo(who.error)); // name/status/code/message only, never the token
    return reply({ error: 'Your sign-in expired. Please sign in again.', auth: true }, 401, clear);
  }
  if (who.unavailable) {
    console.error('[dispatch session] auth check unavailable', authErrInfo(who.error));
    return reply({ error: 'Couldn’t check your sign-in just now. Try again.', retry: true }, 503); // keep whatever cookie there was
  }
  const claims = jwtClaims(token) || {};
  if (claims.sub && who.user?.id && claims.sub !== who.user.id) return reply({ error: 'Sign in again.' }, 401, clear);
  const now = deps?.now ?? Date.now();
  const cookie = authCookieString({ access_token: token, expires_at: Number(claims.exp) || now / 1000 + 3600 }, { now, https });
  if (/Max-Age=0/.test(cookie)) return reply({ error: 'Your sign-in expired. Please sign in again.', auth: true }, 401, clear);
  return reply({ ok: true }, 200, cookie);
}

export async function DELETE(req) {
  if (!sameOrigin(req)) return reply({ error: 'Not allowed.' }, 403);
  return reply({ ok: true }, 200, authCookieString(null, { https: isHttps(req) }));
}
