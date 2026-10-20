// GET  → { companies: [{ profile_id, owner_id, role, name }], active: <one of them> | null }
// POST { profile_id } → sets the HttpOnly ph_active_company cookie, only if the caller belongs to that company.
import { serviceClient, userClient, bearer, checkUser, authErrInfo } from '../../../lib/packetServer';
import { loadMyCompanies, resolveActive, readActiveCookie, activeCookieString } from '../../../lib/activeCompany';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const json = (b, s = 200, cookie) => { const h = new Headers({ 'Cache-Control': 'no-store' }); if (cookie) h.append('Set-Cookie', cookie); return Response.json(b, { status: s, headers: h }); };
const pub = (c) => c && ({ profile_id: c.profile_id, owner_id: c.owner_id, role: c.role, name: c.name });

async function ctx(req, deps = {}) {
  const sb = deps.sb || serviceClient();
  if (!sb) return { err: json({ error: 'Server isn’t configured.' }, 503) };
  const token = bearer(req);
  if (!token) return { err: json({ error: 'Sign in again.' }, 401) };
  const who = await checkUser((deps.mkUserClient || userClient)(token), token, deps.authRetryMs != null ? { retryMs: deps.authRetryMs } : {});
  if (who.rejected) return { err: json({ error: 'Sign in again.' }, 401) };
  if (!who.user) { console.error('[active-company] auth', authErrInfo(who.error)); return { err: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) }; }
  const r = await loadMyCompanies(sb, who.user.id);
  if (r.error) return { err: json({ error: 'Couldn’t load your companies. Try again.' }, 503) };
  return { uid: who.user.id, companies: r.companies };
}

export async function GET(req, { deps } = {}) {
  const c = await ctx(req, deps); if (c.err) return c.err;
  return json({ companies: c.companies.map(pub), active: pub(resolveActive(c.companies, c.uid, readActiveCookie(req))) });
}

export async function POST(req, { deps } = {}) {
  const c = await ctx(req, deps); if (c.err) return c.err;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const pick = c.companies.find((x) => x.profile_id === b?.profile_id);
  if (!pick) return json({ error: 'You’re not a member of that company.' }, 403);
  const https = (() => { try { return new URL(req.url).protocol === 'https:'; } catch { return true; } })();
  return json({ ok: true, active: pub(pick) }, 200, activeCookieString(pick.profile_id, { https }));
}
