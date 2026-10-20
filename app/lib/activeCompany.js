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

export function readActiveCookie(req) {
  const raw = req?.headers?.get?.('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === ACTIVE_COOKIE) {
      const v = decodeURIComponent(part.slice(i + 1).trim());
      return UUIDISH.test(v) ? v : null;
    }
  }
  return null;
}
export const activeCookieString = (id, { https = true } = {}) =>
  `${ACTIVE_COOKIE}=${id ? encodeURIComponent(id) : ''}; Max-Age=${id ? ACTIVE_MAX_S : 0}; Path=/; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;

// Server (service-role client): the caller's companies. → { companies } | { error }
export async function loadMyCompanies(sb, uid) {
  const { data: mems, error } = await sb.from('company_members').select('profile_id, role, created_at').eq('user_id', uid);
  if (error) return { error };
  const { data: owned, error: e2 } = await sb.from('company_profiles').select('id').eq('owner_id', uid);
  if (e2) return { error: e2 };
  const ids = [...new Set([...(mems || []).map((m) => m.profile_id), ...(owned || []).map((p) => p.id)])];
  const out = [];
  for (const id of ids) {
    const { data: p } = await sb.from('company_profiles').select('id, owner_id, legal_name, dba_name').eq('id', id).maybeSingle();
    if (!p) continue;
    const m = (mems || []).find((x) => x.profile_id === id);
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
