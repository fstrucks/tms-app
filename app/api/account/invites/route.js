// Tester invites. Owner only (checked here, server side: the caller must own a company_profiles row).
// GET  → { invites: [...], roles, limit }   POST { email, name?, role? } → invite   POST { action:'resend', email } → resend
// POST { action:'cancel', email, id? } → cancel a still-pending invite from this company (see cancelRefusal).
// POST { action:'role_preview', user_id } → { assigned } loads they drive (for the confirmation).
// POST { action:'role', user_id, role } → change a member's role (Driver/Dispatcher/Management) via public.set_member_role,
//   called with the CALLER's token so the database re-checks owner / same company / not the owner / allowed role.
// No domain limit on invites: outside addresses are allowed (PACKET_SEND_ALLOWED_DOMAINS is for packet emails only).
// Uses the service-role client the app already uses (SUPABASE_SERVICE_ROLE_KEY via serviceClient) for auth.admin.
import { serviceClient, userClient, bearer, checkUser } from '../../../lib/packetServer';
import { validateRoleChange, validateMemberId, setMemberRole, memberAssignedCount, NOT_OWNER_ROLE_TEXT } from '../../../lib/memberRoles';
import { ownerCompany, listAllUsers, inviteRows, validateInvite, invite, resend, cancelInvite, redirectFor, normalizeEmail, INVITE_ROLES, DEFAULT_INVITE_ROLE, HOURLY_LIMIT, recentSends } from '../../../lib/testerInvites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 30;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });

async function ownerCtx(req, deps = {}, { notOwnerText } = {}) {
  const sb = deps.sb || serviceClient();
  if (!sb) return { err: json({ error: 'Server isn’t configured for invites.' }, 503) };
  const token = bearer(req);
  if (!token) return { err: json({ error: 'Sign in again.' }, 401) };
  // Admin action: require Supabase Auth to vouch for the caller (no database fallback here).
  const uc = (deps.mkUserClient || userClient)(token);
  const who = await checkUser(uc, token, deps.authRetryMs != null ? { retryMs: deps.authRetryMs } : {});
  if (who.rejected) return { err: json({ error: 'Sign in again.' }, 401) };
  if (!who.user) return { err: json({ error: 'Couldn’t check your sign-in just now. Try again.', retry: true }, 503) };
  const c = await ownerCompany(sb, who.user.id);
  if (c.error) return { err: json({ error: c.status === 403 && notOwnerText ? notOwnerText : c.error }, c.status) };
  return { sb, uc, owner: who.user, profile: c.profile };
}

export async function GET(req, { deps } = {}) {
  const c = await ownerCtx(req, deps); if (c.err) return c.err;
  const all = await listAllUsers(c.sb.auth.admin);
  if (all.error) return json({ error: 'Could not load invites. Try again.' }, 503);
  const { data: members, error } = await c.sb.from('company_members').select('user_id, role').eq('profile_id', c.profile.id);
  if (error) return json({ error: 'Could not load your company members. Try again.' }, 500);
  return json({ invites: inviteRows(all.users, members, c.profile), roles: INVITE_ROLES, defaultRole: DEFAULT_INVITE_ROLE,
    limit: { hourly: HOURLY_LIMIT, used: recentSends(all.users, c.owner.id, (deps?.now || Date.now)()) }, company: c.profile.legal_name || null, ownerId: c.owner.id });
}

const ROLE_ACTIONS = new Set(['role', 'role_preview']);
export async function POST(req, { deps } = {}) {
  // Peek at the action (without consuming the body) so a non-owner gets text about what they tried to do.
  const peek = await req.clone().json().catch(() => null);
  const roleAction = !!peek && typeof peek === 'object' && ROLE_ACTIONS.has(peek.action);
  const c = await ownerCtx(req, deps, roleAction ? { notOwnerText: NOT_OWNER_ROLE_TEXT } : {}); if (c.err) return c.err;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const now = (deps?.now || Date.now)();
  const redirectTo = redirectFor(req);
  let r;
  if (b?.action === 'role') {
    const v = validateRoleChange(b);
    if (v.error) return json({ error: v.error }, v.status);
    if (v.userId === c.owner.id) return json({ error: 'The owner’s role can’t be changed here.', code: 'owner_locked' }, 409);
    const rr = await setMemberRole(c.uc, v.userId, v.role);
    if (rr.error) { if (rr.code === 'unknown' || rr.code === 'setup') console.error('[invites] role', rr.code); return json({ error: rr.error, code: rr.code }, rr.status); }
    return json({ ok: true, user_id: v.userId, role: rr.role, previous: rr.previous, unassigned: rr.unassigned });
  }
  if (b?.action === 'role_preview') {
    const v = validateMemberId(b);
    if (v.error) return json({ error: v.error }, v.status);
    const pr = await memberAssignedCount(c.uc, v.userId);
    if (pr.error) return json({ error: pr.error, code: pr.code }, pr.status);
    return json({ ok: true, user_id: v.userId, assigned: pr.count });
  }
  if (b?.action === 'resend') {
    const email = normalizeEmail(b.email);
    if (!email) return json({ error: 'Which invite? Missing email.' }, 422);
    r = await resend({ sb: c.sb, owner: c.owner, profile: c.profile, email, redirectTo, now });
  } else if (b?.action === 'cancel') {
    const email = normalizeEmail(b.email);
    if (!email) return json({ error: 'Which invite? Missing email.' }, 422);
    r = await cancelInvite({ sb: c.sb, owner: c.owner, profile: c.profile, email, id: b.id ? String(b.id) : null });
    if (r.error) return json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.partial ? { partial: true } : {}) }, r.status || 500);
    return json({ ok: true, cancelled: r.cancelled });
  } else {
    const v = validateInvite(b);
    if (v.error) return json({ error: v.error }, v.status);
    r = await invite({ sb: c.sb, owner: c.owner, profile: c.profile, input: v, redirectTo, now, ...(deps?.sleep ? { sleep: deps.sleep } : {}) });
  }
  if (r.error) return json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 500);
  return json({ ok: true, emailed: r.emailed !== false, linked: r.linked, ...(r.listed === false ? { listed: false } : {}), ...(r.message ? { message: r.message } : {}), ...(r.warning ? { warning: r.warning } : {}), email: normalizeEmail(r.user?.email) });
}
