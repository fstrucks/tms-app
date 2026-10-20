// Add someone who ALREADY has a PowerHaul account to the owner's company (owner only). No SQL: uses the existing
// public.company_members table (primary key (profile_id, user_id), so a user may belong to more than one company)
// written with the service role, the same way tester invites link new users.
//
// Safety rule: a user is never silently pulled into (or out of) a company.
//   - Not in any company and owns none → added right away (same as an accepted invite).
//   - Already a member of another company, or owns one → a PENDING add is saved on their auth app_metadata
//     (service-role only; user_metadata is user-editable so it's never trusted). They see Accept / Decline the next
//     time they open the app. Accepting ADDS a membership; their other company is never touched.
// Adds count toward the owner's hourly invite limit (same ledger as invites). No email is sent.
import { INVITE_ROLES, DEFAULT_INVITE_ROLE, normalizeEmail, rateLimit, noteOwnerSend, ensureMembership, cleanName } from './testerInvites.js';
import { ROLE_LABELS } from './companyRoles.js';

export const PENDING_KEY = 'pending_company_adds';
export const pendingAdds = (u) => {
  const p = u?.app_metadata?.[PENDING_KEY];
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
};
const roleText = (r) => ROLE_LABELS[r] || r;

async function writeMeta(admin, user, patch) {
  const r = await Promise.resolve(admin.updateUserById(user.id, { app_metadata: { ...(user.app_metadata || {}), ...patch } })).catch((e) => ({ error: e }));
  if (r?.error) console.error('[company-adds] meta', r.error.code || r.error.status || '');
  return r?.error || null;
}
const withPending = (user, map) => { user.app_metadata = { ...(user.app_metadata || {}), [PENDING_KEY]: map }; return map; };

// existing = the auth user found by email. → { ok, added|pending, message } | { error, status, code }
export async function addExisting({ sb, owner, profile, existing, role, users, now = Date.now() }) {
  if (!INVITE_ROLES.includes(role)) role = DEFAULT_INVITE_ROLE;
  const email = normalizeEmail(existing.email);
  if (existing.id === owner.id) return { error: 'That’s your own account. You’re already the owner.', status: 409, code: 'self' };
  const { data: mems, error: mErr } = await sb.from('company_members').select('profile_id, role').eq('user_id', existing.id);
  if (mErr) return { error: 'Could not check that account’s companies. Nothing was changed.', status: 500 };
  const here = (mems || []).find((m) => m.profile_id === profile.id);
  if (here) return { error: `${email} is already in your company (${roleText(here.role)}).`, status: 409, code: 'already_member' };
  const { data: owned, error: oErr } = await sb.from('company_profiles').select('id').eq('owner_id', existing.id).maybeSingle();
  if (oErr) return { error: 'Could not check that account’s companies. Nothing was changed.', status: 500 };
  if (pendingAdds(existing)[profile.id]) return { error: `${email} already has a pending add to your company. They’ll see it next time they open PowerHaul.`, status: 409, code: 'already_pending' };
  const rl = rateLimit(users, owner.id, null, now); if (rl) return rl;
  const other = (mems || []).some((m) => m.profile_id !== profile.id) || !!owned;
  await noteOwnerSend(sb.auth.admin, users, owner.id, now);
  if (!other) {
    const m = await ensureMembership(sb, profile, existing.id, role);
    if (m.error) return { error: 'Couldn’t add them to your company. Try again.', status: 500 };
    if (!m.existing) existing.added_at = new Date(now).toISOString();
    return { ok: true, added: true, user: existing, linked: true, role, message: `${email} already had a PowerHaul account, so they were added to your company as ${roleText(role)}. No email was sent.` };
  }
  const map = { ...pendingAdds(existing), [profile.id]: { by: owner.id, role, at: new Date(now).toISOString(), company_name: cleanName(profile.legal_name || '') || null } };
  const err = await writeMeta(sb.auth.admin, existing, { [PENDING_KEY]: map });
  if (err) return { error: 'Couldn’t save the add. Try again.', status: 500 };
  withPending(existing, map);
  return { ok: true, pending: true, user: existing, linked: false, role, message: `${email} is already in another company, so they need to accept. They’ll see “Join ${profile.legal_name || 'your company'}?” the next time they open PowerHaul. They stay in their other company too.` };
}

// Owner withdraws a pending add. → { ok } | { error }
export async function cancelAdd({ sb, profile, user }) {
  const map = { ...pendingAdds(user) };
  if (!map[profile.id]) return { error: 'No pending add for that person.', status: 404 };
  delete map[profile.id];
  const err = await writeMeta(sb.auth.admin, user, { [PENDING_KEY]: map });
  return err ? { error: 'Couldn’t cancel the add. Try again.', status: 500 } : { ok: true, cancelled: normalizeEmail(user.email) };
}

// The signed-in user's own pending adds, re-validated (company still exists and is still owned by whoever added).
export async function myPendingAdds(sb, user) {
  const out = [];
  for (const [company, rec] of Object.entries(pendingAdds(user))) {
    if (!rec || typeof rec !== 'object') continue;
    const { data: p } = await sb.from('company_profiles').select('id, owner_id, legal_name').eq('id', company).maybeSingle();
    if (!p || p.owner_id !== rec.by) continue;
    out.push({ company, company_name: p.legal_name || rec.company_name || 'a company', role: INVITE_ROLES.includes(rec.role) ? rec.role : DEFAULT_INVITE_ROLE, at: rec.at || null });
  }
  return out;
}

// Accept or decline one pending add. → { ok, joined? } | { error, status }
export async function respondAdd({ sb, user, company, accept }) {
  const map = { ...pendingAdds(user) };
  const rec = map[company];
  if (!rec) return { error: 'That add is no longer pending.', status: 404 };
  if (accept) {
    const valid = (await myPendingAdds(sb, user)).find((x) => x.company === company);
    if (!valid) { delete map[company]; await writeMeta(sb.auth.admin, user, { [PENDING_KEY]: map }); return { error: 'That company is no longer available.', status: 410 }; }
    const m = await ensureMembership(sb, { id: company }, user.id, valid.role);
    if (m.error) return { error: 'Couldn’t join just now. Try again.', status: 500 };
    delete map[company];
    await writeMeta(sb.auth.admin, user, { [PENDING_KEY]: map });
    return { ok: true, joined: true, company_name: valid.company_name, role: m.role || valid.role };
  }
  delete map[company];
  const err = await writeMeta(sb.auth.admin, user, { [PENDING_KEY]: map });
  return err ? { error: 'Couldn’t save that. Try again.', status: 500 } : { ok: true, joined: false };
}

// Join success text, from the fresh active-company answer (lib/activeCompany: owned company stays the default,
// otherwise the newest join becomes active).
export function joinedText(a, ac) {
  const role = roleText(a.role);
  if (ac?.active?.profile_id === a.company) return `You joined ${a.company_name} as ${role}, and you’re working in it now. Switch companies anytime from the account menu.`;
  return `You joined ${a.company_name} as ${role}. You’re still working in ${ac?.active?.name || 'your current company'}. Tap Switch now, or use Company in the account menu.`;
}
