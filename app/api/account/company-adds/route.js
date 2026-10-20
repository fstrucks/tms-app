// The signed-in user's pending "added to a company" requests (see app/lib/companyAdds.js).
// GET → { adds: [{ company, company_name, role, at }] }   POST { company, accept: true|false } → join or decline.
// The caller is identified by Supabase Auth (their own token); the pending record is read fresh from the admin API.
import { serviceClient, userClient, bearer, checkUser, authErrInfo } from '../../../lib/packetServer';
import { myPendingAdds, respondAdd } from '../../../lib/companyAdds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });

async function me(req, deps = {}) {
  const sb = deps.sb || serviceClient();
  if (!sb) return { err: json({ error: 'Server isn’t configured.' }, 503) };
  const token = bearer(req);
  if (!token) return { err: json({ error: 'Sign in again.' }, 401) };
  const who = await checkUser((deps.mkUserClient || userClient)(token), token, deps.authRetryMs != null ? { retryMs: deps.authRetryMs } : {});
  if (who.rejected) return { err: json({ error: 'Sign in again.' }, 401) };
  if (!who.user) { console.error('[company-adds] auth', authErrInfo(who.error)); return { err: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) }; }
  const { data, error } = await sb.auth.admin.getUserById(who.user.id);
  if (error || !data?.user) return { err: json({ error: 'Couldn’t load your account. Try again.' }, 503) };
  return { sb, user: data.user };
}

export async function GET(req, { deps } = {}) {
  const c = await me(req, deps); if (c.err) return c.err;
  return json({ adds: await myPendingAdds(c.sb, c.user) });
}

export async function POST(req, { deps } = {}) {
  const c = await me(req, deps); if (c.err) return c.err;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const company = typeof b?.company === 'string' ? b.company : '';
  if (!company || typeof b.accept !== 'boolean') return json({ error: 'Bad request.' }, 422);
  const r = await respondAdd({ sb: c.sb, user: c.user, company, accept: b.accept });
  if (r.error) return json({ error: r.error }, r.status || 500);
  return json(r);
}
