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
import { addExisting, pendingAdds, addedTimes } from './companyAdds.js';

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
  const memberAt = new Map((members || []).map((m) => [m.user_id, m.created_at || null]));
  const memberAlso = new Map((members || []).map((m) => [m.user_id, m.also_drives === true])); // 20261020000100
  // QA #103 (b, c): an invite date only when THIS company sent the invite; otherwise "added <date>": the pending
  // add's own time, or when the membership row was created (direct add).
  const ownInvite = (u) => inviteMeta(u).company === profile.id;
  const addedAt = (u) => (!memberRole.has(u.id) && pendingAdds(u)[profile.id]?.at) || (memberRole.has(u.id) && addedTimes(u)[profile.id]) || (!ownInvite(u) && memberAt.get(u.id)) || null;
  return (users || [])
    .filter((u) => u.id !== profile.owner_id && (memberRole.has(u.id) || inviteMeta(u).company === profile.id || !!pendingAdds(u)[profile.id]))
    .map((u) => ({
      id: u.id, email: normalizeEmail(u.email), name: u.user_metadata?.full_name || null,
      role: memberRole.get(u.id) || (!memberRole.has(u.id) && pendingAdds(u)[profile.id]?.role) || inviteMeta(u).role || null, linked: memberRole.has(u.id),
      also_drives: memberAlso.get(u.id) === true,
      status: !memberRole.has(u.id) && pendingAdds(u)[profile.id] ? 'add_pending' : inviteStatus(u),
      invited_at: ownInvite(u) || (!addedAt(u) && memberRole.has(u.id)) ? u.invited_at || null : null, added_at: addedAt(u), accepted_at: u.email_confirmed_at || u.confirmed_at || null, last_sign_in_at: u.last_sign_in_at || null,
    }))
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.invited_at || b.added_at || '').localeCompare(String(a.invited_at || a.added_at || '')));
}

// Rate limit from data we already have (no table): invites/resends this owner made in the last hour, read from
// app_metadata logs (owner's invite_sends + each invitee's tester_invite.log), plus a per-address cooldown.
const hourAgo = (now) => now - 60 * 60 * 1000;
// Sends are also kept on the OWNER's own app_metadata.invite_sends, so a send still counts if its per-invitee record
// failed to save, or the invitee was later cancelled (deleteUser removes their log). Count = union of both, deduped
// per timestamp (see recentSends), so older per-invitee logs keep counting too.
export const ownerSends = (users, ownerId) => {
  const o = (users || []).find((u) => u.id === ownerId);
  const a = o?.app_metadata?.invite_sends;
  return Array.isArray(a) ? a.filter((t) => typeof t === 'string') : [];
};
// Multiset union: per timestamp, max(count in owner ledger, count in invitee logs), so the same send logged in both
// places counts once, while separate sends that share a millisecond still each count.
export function recentSends(users, ownerId, now = Date.now()) {
  const a = new Map(), b = new Map();
  const add = (m, t) => { if (Date.parse(t) > hourAgo(now)) m.set(t, (m.get(t) || 0) + 1); };
  for (const t of ownerSends(users, ownerId)) add(a, t);
  for (const u of users || []) if (inviteMeta(u).by === ownerId) for (const t of inviteMeta(u).log || []) add(b, t);
  let n = 0;
  for (const t of new Set([...a.keys(), ...b.keys()])) n += Math.max(a.get(t) || 0, b.get(t) || 0);
  return n;
}
// Append one send to the owner's ledger (fresh app_metadata from the admin list; other keys kept). → error | null
export async function noteOwnerSend(admin, users, ownerId, now) {
  const o = (users || []).find((u) => u.id === ownerId);
  const at = new Date(now).toISOString();
  const invite_sends = [...ownerSends(users, ownerId).filter((t) => Date.parse(t) > hourAgo(now)), at].slice(-50);
  const r = await Promise.resolve(admin.updateUserById(ownerId, { app_metadata: { ...(o?.app_metadata || {}), invite_sends } })).catch((e) => ({ error: e }));
  if (r?.error) console.error('[invites] owner send log', r.error.code || r.error.status || '');
  return r?.error || null;
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

export const RETRY_DELAY_MS = 300; // short pause before retrying a failed write (injectable for tests)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const inviterName = (o) => cleanName(o?.user_metadata?.full_name || o?.user_metadata?.name || '') || null;
// New invite. → { ok, user, linked, warning? } | { error, status, code? }
export async function invite({ sb, owner, profile, input, redirectTo, now = Date.now(), users: known, sleep = wait }) {
  const admin = sb.auth.admin;
  const all = known ? { users: known } : await listAllUsers(admin);
  if (all.error) return { error: 'Could not check existing accounts. Nothing was sent.', status: 503 };
  const existing = findByEmail(all.users, input.email);
  if (existing) {
    const st = inviteStatus(existing);
    if (st === 'pending') return { error: `${input.email} was already invited${existing.invited_at ? ` on ${existing.invited_at.slice(0, 10)}` : ''} and hasn’t accepted yet. Use Resend instead.`, status: 409, code: 'already_invited', id: existing.id };
    // Existing account: add them instead of inviting (see companyAdds.js; may need their Accept).
    return addExisting({ sb, owner, profile, existing, role: input.role, users: all.users, now });
  }
  const rl = rateLimit(all.users, owner.id, null, now); if (rl) return rl;
  // Display-only values for the email template ({{ .Data.company_name }}, {{ .Data.inviter_name }}); never trusted.
  const data0 = { ...(input.name ? { full_name: input.name } : {}), ...(profile.legal_name ? { company_name: String(profile.legal_name).slice(0, 120) } : {}),
    ...(inviterName(owner) ? { inviter_name: inviterName(owner) } : {}) };
  const { data, error } = await admin.inviteUserByEmail(input.email, { redirectTo, data: data0 });
  if (error) return inviteError(error, input.email);
  await noteOwnerSend(admin, all.users, owner.id, now); // counts toward the hourly limit even if the steps below fail
  const user = data?.user;
  if (!user?.id) return { error: 'The invite didn’t return a user. Check the list before trying again.', status: 502 };
  // The list shows an invite only if at least one of these two writes landed (inviteRows: app_metadata record OR
  // company_members row). Each is retried once; if both still fail the invite would be invisible AND stranded
  // (re-invite → 409 "use Resend", Resend → 404 "not your company"), so say so plainly instead of a success.
  const log = [new Date(now).toISOString()];
  let recErr = await record(admin, user, owner.id, profile, input.role, log);
  if (recErr) { await sleep(RETRY_DELAY_MS); recErr = await record(admin, user, owner.id, profile, input.role, log); }
  let m = await ensureMembership(sb, profile, user.id, input.role);
  if (m.error) { await sleep(RETRY_DELAY_MS); m = await ensureMembership(sb, profile, user.id, input.role); }
  if (m.error && recErr) {
    console.error('[invites] invite sent but not recorded or linked', 'owner', owner.id, 'user', user.id, m.error.code || '');
    return { ok: true, user, linked: false, listed: false, warning: `The invite email went to ${input.email}, but it couldn’t be saved to your company, so it won’t show in the list below. Don’t send it again (that uses another email). Contact support to link it.` };
  }
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
  await noteOwnerSend(admin, all.users, owner.id, now);
  await record(admin, u, inviteMeta(u).by || owner.id, profile, role, keepLog(u, now)); // this send counts toward the hourly limit
  const m = await ensureMembership(sb, profile, u.id, role);
  return { ok: true, user: u, emailed: true, linked: !m.error, ...(m.error ? { warning: 'Resent, but adding them to your company failed. Try Resend again later.' } : {}) };
}

// ---------- cancel a pending invite ----------
// Still pending = invited, never confirmed, never signed in.
export const isStillPending = (u) => !!u && !!u.invited_at && !u.email_confirmed_at && !u.confirmed_at && !u.last_sign_in_at;
// Why a cancel is refused (null = allowed). Pure, so every rule is unit-tested.
//   - must still be pending (fresh read from the admin API, right before deleting);
//   - the invite must be this company's: the server-only record (app_metadata.tester_invite.company) says so, OR,
//     for invites made before this PR (no record at all), there is a company_members row for this company;
//     a record naming another company always refuses;
//   - no membership in any other company, and they own no company profile.
export function cancelRefusal(u, { profile, memberships = [], ownsCompany = false }) {
  if (!u) return 'not_found';
  if (!isStillPending(u)) return 'not_pending';
  const rec = inviteMeta(u);
  const hasRecord = Object.keys(rec).length > 0;
  const here = memberships.some((m) => m.profile_id === profile.id);
  if (hasRecord ? rec.company !== profile.id : !here) return 'other_company';
  if (memberships.some((m) => m.profile_id !== profile.id) || ownsCompany) return 'other_membership';
  return null;
}
const CANCEL_MSG = {
  not_found: ['No invite for that email.', 404],
  not_pending: ['They’ve already accepted (or signed in), so the invite can’t be cancelled here.', 409],
  other_company: ['That invite isn’t from your company.', 404],
  other_membership: ['That person also belongs to another company, so their account can’t be removed here.', 409],
};
export async function cancelInvite({ sb, owner, profile, email, id, users: known }) {
  const admin = sb.auth.admin;
  const refuse = (why, uid) => { console.warn('[invites] cancel refused', why, 'owner', owner.id, 'user', uid || '-'); const [error, status] = CANCEL_MSG[why]; return { error, status, code: why }; };
  const all = known ? { users: known } : await listAllUsers(admin);
  if (all.error) return { error: 'Could not check the invite. Nothing was changed.', status: 503 };
  const listed = findByEmail(all.users, email);
  if (!listed || (id && listed.id !== id)) return refuse('not_found', listed?.id);
  // Fresh read right before deciding (they may have accepted since the list loaded).
  const fresh = await admin.getUserById(listed.id);
  if (fresh?.error) return { error: 'Could not check the invite. Nothing was changed.', status: 503 };
  const u = fresh?.data?.user || null;
  if (!u) return refuse('not_found', listed.id);
  const { data: memberships, error: mErr } = await sb.from('company_members').select('profile_id, role').eq('user_id', u.id);
  const { data: owned, error: oErr } = await sb.from('company_profiles').select('id').eq('owner_id', u.id);
  if (mErr || oErr) return { error: 'Could not check the invite. Nothing was changed.', status: 503 };
  const why = cancelRefusal(u, { profile, memberships: memberships || [], ownsCompany: (owned || []).length > 0 });
  if (why) return refuse(why, u.id);
  // Membership row first (only this company's), then the unaccepted auth user.
  const del = await sb.from('company_members').delete().eq('profile_id', profile.id).eq('user_id', u.id);
  if (del?.error) { console.error('[invites] cancel membership', del.error.code); return { error: 'Could not remove them from your company. Nothing else was changed.', status: 500 }; }
  const gone = await Promise.resolve(admin.deleteUser(u.id)).catch((e) => ({ error: e }));
  if (gone?.error) {
    console.error('[invites] cancel deleteUser', gone.error.status || '', gone.error.code || '');
    return { error: 'Removed from your company, but the invite itself couldn’t be deleted. The link in their email may still work; try Cancel again.', status: 502, partial: true };
  }
  console.info('[invites] cancelled', 'owner', owner.id, 'user', u.id, inviteMeta(u).company ? 'record' : 'legacy-membership');
  return { ok: true, cancelled: normalizeEmail(u.email) };
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

// Client-side, non-blocking: does the typed email match someone already in the list? → { kind, text } | null
export function existingHint(list, typed) {
  const e = normalizeEmail(typed);
  if (!e || !EMAIL.test(e)) return null;
  const x = (list || []).find((r) => normalizeEmail(r.email) === e);
  if (!x) return null;
  if (x.status === 'add_pending') return { kind: 'pending', text: `${e} was already added and hasn’t accepted yet.` };
  if (x.status === 'pending') return { kind: 'pending', text: `${e} already has a pending invite. Use Resend in the list below instead of sending a new one.` };
  return { kind: 'member', text: `${e} is already in your company${x.role ? ` (${ROLE_LABELS[x.role] || x.role})` : ''}. No new invite is needed.` };
}
