// In-app tester invites (owner only). Pure-ish helpers with an injected Supabase service client so every path is
// unit-testable with a mocked admin API. Nothing here sends on its own: an email only goes out when the route calls
// invite() / resend() on an explicit owner request.
//
// Linking: a new user joins the owner's company through an existing table, public.company_members
// (profile_id = the owner's company_profiles.id, user_id = the invited auth user, role in
// owner|dispatcher|management|driver). Inserted with the service role at invite time (and re-checked on resend).
// No new tables, columns, policies or triggers. Who invited them, for which company/role, and the send log live in
// the auth user's app_metadata.tester_invite (only the service role can write it; user_metadata is user-editable, so
// it only carries the display name).
import { ROLE_LABELS } from './companyRoles.js';

export const INVITE_ROLES = ['driver', 'dispatcher', 'management']; // never 'owner'
export const DEFAULT_INVITE_ROLE = 'driver'; // least privilege; pick Dispatcher/Management for testers who edit packets
export const INVITE_PATH = '/account/password';
export const HOURLY_LIMIT = 10; // invites + resends per owner per rolling hour (Postmark free plan: 100/month)
export const RESEND_COOLDOWN_MS = 2 * 60 * 1000; // per address
export const MAX_NAME = 80;
const EMAIL = /^[^\s@<>(),;:"\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const LIST_PAGE = 1000, LIST_MAX_PAGES = 10;

export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();
export const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();

// → { email, name, role } | { error, status }
export function validateInvite(b = {}) {
  const email = normalizeEmail(b.email);
  if (!email) return { error: 'Enter the tester’s email.', status: 422 };
  if (email.length > 254 || !EMAIL.test(email)) return { error: `“${email}” isn’t a valid email.`, status: 422 };
  const role = b.role == null || b.role === '' ? DEFAULT_INVITE_ROLE : String(b.role);
  if (!INVITE_ROLES.includes(role)) return { error: 'Pick Driver, Dispatcher or Management.', status: 422 };
  return { email, name: cleanName(b.name) || null, role };
}

// Auth user → 'accepted' | 'pending' | 'active' (signed up some other way, never invited).
export function inviteStatus(u) {
  if (!u) return null;
  if (u.last_sign_in_at || u.email_confirmed_at || u.confirmed_at) return u.invited_at ? 'accepted' : 'active';
  return u.invited_at ? 'pending' : 'unconfirmed';
}

// All auth users (paged). admin = sb.auth.admin.
export async function listAllUsers(admin) {
  const out = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: LIST_PAGE });
    if (error) return { error };
    const users = data?.users || [];
    out.push(...users);
    if (users.length < LIST_PAGE) break;
  }
  return { users: out };
}
// Trusted invite record (app_metadata; never user_metadata).
export const inviteMeta = (u) => (u?.app_metadata?.tester_invite && typeof u.app_metadata.tester_invite === 'object' ? u.app_metadata.tester_invite : {});
export const findByEmail = (users, email) => (users || []).find((u) => normalizeEmail(u.email) === normalizeEmail(email)) || null;

// The caller's company (they must own it). → { profile } | { error, status }
export async function ownerCompany(sb, userId) {
  const { data, error } = await sb.from('company_profiles').select('id, owner_id, legal_name').eq('owner_id', userId).maybeSingle();
  if (error) return { error: 'Could not check your company. Try again.', status: 500 };
  if (!data) return { error: 'Only the company owner can invite testers.', status: 403 };
  return { profile: data };
}

// Rows for the list: this company's members (minus the owner) plus anyone this owner invited.
export function inviteRows(users, members, profile) {
  const memberRole = new Map((members || []).map((m) => [m.user_id, m.role]));
  return (users || [])
    .filter((u) => u.id !== profile.owner_id && (memberRole.has(u.id) || inviteMeta(u).company === profile.id))
    .map((u) => ({
      id: u.id, email: normalizeEmail(u.email), name: u.user_metadata?.full_name || null,
      role: memberRole.get(u.id) || inviteMeta(u).role || null, linked: memberRole.has(u.id),
      status: inviteStatus(u), invited_at: u.invited_at || null, accepted_at: u.email_confirmed_at || u.confirmed_at || null, last_sign_in_at: u.last_sign_in_at || null,
    }))
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.invited_at || '').localeCompare(String(a.invited_at || '')));
}

// Rate limit from data we already have (no table): invites/resends this owner made in the last hour, read from
// user_metadata.invite_log (timestamps the route writes), plus a per-address cooldown from invited_at.
const hourAgo = (now) => now - 60 * 60 * 1000;
export function recentSends(users, ownerId, now = Date.now()) {
  let n = 0;
  for (const u of users || []) if (inviteMeta(u).by === ownerId) for (const t of inviteMeta(u).log || []) if (Date.parse(t) > hourAgo(now)) n++;
  return n;
}
export function rateLimit(users, ownerId, target, now = Date.now(), { limit = HOURLY_LIMIT, cooldownMs = RESEND_COOLDOWN_MS } = {}) {
  if (recentSends(users, ownerId, now) >= limit) return { error: `You’ve sent ${limit} invites in the last hour. Try again later.`, status: 429 };
  const last = target && Math.max(Date.parse(target.invited_at || 0) || 0, ...((inviteMeta(target).log || []).map((t) => Date.parse(t) || 0)));
  if (last && now - last < cooldownMs) return { error: 'An invite was just sent to this address. Wait a couple of minutes before resending.', status: 429 };
  return null;
}

// company_members row for the user (idempotent). → { ok } | { error }
export async function ensureMembership(sb, profile, userId, role) {
  if (!INVITE_ROLES.includes(role)) role = DEFAULT_INVITE_ROLE;
  const { data: have, error: e1 } = await sb.from('company_members').select('role').eq('profile_id', profile.id).eq('user_id', userId).maybeSingle();
  if (e1) return { error: e1 };
  if (have) return { ok: true, existing: true, role: have.role }; // never change an existing member's role here
  const { error } = await sb.from('company_members').insert({ profile_id: profile.id, user_id: userId, role });
  if (error && error.code !== '23505') return { error };
  return { ok: true, role };
}

const keepLog = (u, now) => [...(inviteMeta(u).log || []).filter((t) => Date.parse(t) > hourAgo(now)), new Date(now).toISOString()].slice(-20);
// Write the trusted record (no email). → error | null
async function record(admin, user, ownerId, profile, role, log) {
  const app_metadata = { ...(user.app_metadata || {}), tester_invite: { by: ownerId, company: profile.id, role, log } };
  const r = await Promise.resolve(admin.updateUserById(user.id, { app_metadata })).catch((e) => ({ error: e }));
  if (r?.error) console.error('[invites] record', r.error.code || r.error.status || '');
  return r?.error || null;
}

// New invite. → { ok, user, linked, warning? } | { error, status, code? }
export async function invite({ sb, owner, profile, input, redirectTo, now = Date.now(), users: known }) {
  const admin = sb.auth.admin;
  const all = known ? { users: known } : await listAllUsers(admin);
  if (all.error) return { error: 'Could not check existing accounts. Nothing was sent.', status: 503 };
  const existing = findByEmail(all.users, input.email);
  if (existing) {
    const st = inviteStatus(existing);
    if (st === 'pending') return { error: `${input.email} was already invited${existing.invited_at ? ` on ${existing.invited_at.slice(0, 10)}` : ''} and hasn’t accepted yet. Use Resend instead.`, status: 409, code: 'already_invited', id: existing.id };
    return { error: `${input.email} already has a PowerHaul account. No invite was sent.`, status: 409, code: 'already_registered', id: existing.id };
  }
  const rl = rateLimit(all.users, owner.id, null, now); if (rl) return rl;
  const { data, error } = await admin.inviteUserByEmail(input.email, { redirectTo, data: input.name ? { full_name: input.name } : {} });
  if (error) return inviteError(error, input.email);
  const user = data?.user;
  if (!user?.id) return { error: 'The invite didn’t return a user. Check the list before trying again.', status: 502 };
  await record(admin, user, owner.id, profile, input.role, [new Date(now).toISOString()]);
  const m = await ensureMembership(sb, profile, user.id, input.role);
  if (m.error) { console.error('[invites] link', m.error.code); return { ok: true, user, linked: false, warning: 'The invite was sent, but adding them to your company failed. Press Resend later to retry the link (it won’t email if they already accepted).' }; }
  return { ok: true, user, linked: true, role: m.role };
}

// Resend to a pending invite of this company (also re-links). Accepted users are only re-linked, never emailed.
export async function resend({ sb, owner, profile, email, redirectTo, now = Date.now(), users: known }) {
  const admin = sb.auth.admin;
  const all = known ? { users: known } : await listAllUsers(admin);
  if (all.error) return { error: 'Could not check existing accounts. Nothing was sent.', status: 503 };
  const u = findByEmail(all.users, email);
  if (!u) return { error: 'No invite for that email. Send a new invite instead.', status: 404 };
  const { data: mem } = await sb.from('company_members').select('role').eq('profile_id', profile.id).eq('user_id', u.id).maybeSingle();
  if (inviteMeta(u).company !== profile.id && !mem) return { error: 'That person wasn’t invited to your company.', status: 404 };
  const role = mem?.role || inviteMeta(u).role || DEFAULT_INVITE_ROLE;
  if (inviteStatus(u) !== 'pending') {
    const m = await ensureMembership(sb, profile, u.id, role);
    return m.error ? { error: 'They already accepted, and linking them to your company failed. Try again.', status: 500 } : { ok: true, user: u, linked: true, emailed: false, message: `${normalizeEmail(u.email)} already accepted. No email sent.` };
  }
  const rl = rateLimit(all.users, owner.id, u, now); if (rl) return rl;
  // GoTrue re-sends the invite for an existing, unconfirmed user.
  const { error } = await admin.inviteUserByEmail(normalizeEmail(u.email), { redirectTo });
  if (error) return inviteError(error, u.email);
  await record(admin, u, inviteMeta(u).by || owner.id, profile, role, keepLog(u, now)); // this send counts toward the hourly limit
  const m = await ensureMembership(sb, profile, u.id, role);
  return { ok: true, user: u, emailed: true, linked: !m.error, ...(m.error ? { warning: 'Resent, but adding them to your company failed. Try Resend again later.' } : {}) };
}

function inviteError(error, email) {
  const code = error.code || '', status = error.status || 0;
  console.error('[invites] invite', status, code);
  if (code === 'email_exists' || code === 'user_already_exists' || /already been registered/i.test(error.message || '')) return { error: `${normalizeEmail(email)} already has a PowerHaul account. No invite was sent.`, status: 409, code: 'already_registered' };
  if (status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return { error: 'The email service’s hourly limit was reached. Try again later.', status: 429 };
  return { error: 'The invite couldn’t be sent. Try again in a few minutes.', status: 502 };
}

export const roleLabel = (r) => ROLE_LABELS[r] || r || '—';
// <origin>/account/password for the deployment that got the request (the current invite template builds its link
// from the Site URL; redirectTo must be in the Redirect URLs allow-list, which covers prod and *-fst-tms previews).
export function redirectFor(req) {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { /* keep '' */ }
  return `${origin}${INVITE_PATH}`;
}
