// Active company for users who belong to more than one (e.g. a dispatcher added to a second company).
// The choice lives in an HttpOnly cookie (ph_active_company = a company_profiles.id) set ONLY by
// POST /api/account/active-company after checking company_members; every reader re-validates it against the
// caller's own memberships, so a stale or forged value just falls back to the default. Never a permission:
// roles still come from company_members / the database on every request.
// Default: the company the user owns, otherwise the one they joined most recently.
export const ACTIVE_COOKIE = 'ph_active_company';
export const ACTIVE_MAX_S = 365 * 24 * 3600;
export const ACTIVE_EVENT = 'powerhaul:active-company';
const UUIDISH = /^[0-9a-f-]{8,64}$/i;

// companies: [{ profile_id, owner_id, role, name, joined_at }] → the active one (or null).
export function resolveActive(companies, uid, choice) {
  const list = companies || [];
  if (!list.length) return null;
  if (choice) { const c = list.find((x) => x.profile_id === choice); if (c) return c; }
  const owned = list.find((x) => x.owner_id === uid || x.role === 'owner');
  if (owned) return owned;
  return [...list].sort((a, b) => String(b.joined_at || '').localeCompare(String(a.joined_at || '')))[0];
}

// QA #103 re-test (a): the cookie is per browser, not per person, so a choice made by one test account was picked
// up by the next account signed in on the same browser once it joined that company. The value is now
// "<user id>.<profile id>" and only counts for that user.
export function readActiveCookie(req, uid) {
  const raw = req?.headers?.get?.('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === ACTIVE_COOKIE) {
      let v = ''; try { v = decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
      const dot = v.indexOf('.');
      if (dot < 0 || !uid || v.slice(0, dot) !== uid) return null;
      const id = v.slice(dot + 1);
      return UUIDISH.test(id) ? id : null;
    }
  }
  return null;
}
export const activeCookieString = (id, { https = true, uid } = {}) =>
  `${ACTIVE_COOKIE}=${id && uid ? encodeURIComponent(`${uid}.${id}`) : ''}; Max-Age=${id ? ACTIVE_MAX_S : 0}; Path=/; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;

// Server (service-role client): the caller's companies. → { companies } | { error }
export async function loadMyCompanies(sb, uid) {
  const { data: mems, error } = await sb.from('company_members').select('profile_id, role, created_at').eq('user_id', uid);
  if (error) return { error };
  const { data: owned, error: e2 } = await sb.from('company_profiles').select('id').eq('owner_id', uid);
  if (e2) return { error: e2 };
  const ids = [...new Set([...(mems || []).map((m) => m.profile_id), ...(owned || []).map((p) => p.id)])];
  if (!ids.length) return { companies: [] };
  // QA #103 re-test (b): one query for all of them (was one per company).
  const { data: profs, error: e3 } = await sb.from('company_profiles').select('id, owner_id, legal_name, dba_name').in('id', ids);
  if (e3) return { error: e3 };
  const out = [];
  for (const p of profs || []) {
    const m = (mems || []).find((x) => x.profile_id === p.id);
    out.push({ profile_id: p.id, owner_id: p.owner_id, role: p.owner_id === uid ? 'owner' : m?.role || null,
      name: (p.dba_name || '').trim() || (p.legal_name || '').trim() || 'Company', joined_at: m?.created_at || null });
  }
  return { companies: out.filter((c) => c.role) };
}

// Pick the profile row /api/company-profile should use. profiles = rows visible to the caller (RLS),
// members = the caller's own company_members rows (with created_at).
export function pickProfile(profiles, members, uid, choice) {
  const list = (profiles || []).map((p) => {
    const m = (members || []).find((x) => x.profile_id === p.id && x.user_id === uid);
    return { profile_id: p.id, owner_id: p.owner_id, role: p.owner_id === uid ? 'owner' : m?.role || null, joined_at: m?.created_at || null, p };
  }).filter((c) => c.role);
  return resolveActive(list, uid, choice)?.p || null;
}
