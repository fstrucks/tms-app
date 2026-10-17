// Server helpers for /api/company/insurance/*. Uses the CALLER's token so RLS applies (no service role).
import { userClient, bearer, isAuthRejection } from './packetServer.js';
import { isRole } from './companyRoles.js';

export const INS_WRITE_ROLES = new Set(['owner', 'management']);
export const canWriteInsurance = (r) => INS_WRITE_ROLES.has(r);
export const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
export const isMissing = (e) => !!e && (e.code === '42P01' || e.code === '42703' || e.code === 'PGRST204' || e.code === 'PGRST205' || /does not exist|Could not find the/i.test(e.message || ''));

// → { sb, user, ownerId, role, profile } | { res }
export async function insuranceCtx(req, { mkUserClient = userClient } = {}) {
  const token = bearer(req);
  if (!token) return { res: json({ error: 'Sign in first.' }, 401) };
  const sb = mkUserClient(token);
  const { data: u, error: uErr } = await sb.auth.getUser(token);
  if (uErr && !isAuthRejection(uErr)) return { res: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) };
  if (!u?.user) return { res: json({ error: 'Your sign-in expired. Please sign in again.' }, 401) };
  const { data: profiles, error } = await sb.from('company_profiles').select('*').limit(1);
  if (error) return { res: json({ error: 'Could not load the company profile.' }, 500) };
  const profile = profiles?.[0] || null;
  const ownerId = profile?.owner_id || u.user.id;
  const { data: role } = await sb.rpc('packet_role', { p_owner: ownerId });
  if (!isRole(role)) return { res: json({ error: 'Not allowed.' }, 403) };
  return { sb, user: u.user, ownerId, role, profile };
}
