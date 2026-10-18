// Owner-only Bug reports list (server). Who is an "owner": the caller owns a company_profiles row
// (owner_id = caller), checked with the caller's OWN token (RLS). Same rule as roleFor() / packet_role and
// Alex's tester invites. Testers invited by that owner are company_members of that company, so the owner sees
// reports filed by: themselves + every member of their company. Nobody else's.
// bug_reports RLS is own-rows only, so the read uses the service client, filtered by exactly those user_ids
// (the /truck pattern). Screenshot links: short-lived signed URLs, created here only after the owner check.
export const SIGNED_URL_TTL = 600; // seconds
export const LIST_LIMIT = 200;
export const isMissingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST204' || /does not exist|Could not find the/i.test(e.message || ''));
export const ownScreenshot = (r) => !!r?.screenshot_path && r.screenshot_path.startsWith(`${r.user_id}/bug-reports/`) && !r.screenshot_path.includes('..');

// → { profile } | { notOwner: true } | { error }
export async function ownerProfile(uc, userId) {
  const { data, error } = await uc.from('company_profiles').select('id, owner_id').eq('owner_id', userId).limit(1);
  if (error && !isMissingTable(error)) return { error: 'Could not check your company.' };
  const p = data?.[0];
  return p && p.owner_id === userId ? { profile: p } : { notOwner: true };
}

// → { reports } | { setupNeeded: true } | { error }
export async function listBugReports(svc, profile, { ttl = SIGNED_URL_TTL } = {}) {
  const m = await svc.from('company_members').select('user_id').eq('profile_id', profile.id);
  if (m.error && !isMissingTable(m.error)) return { error: 'Could not load your team.' };
  const ids = [...new Set([profile.owner_id, ...(m.data || []).map((x) => x.user_id).filter(Boolean)])];
  const r = await svc.from('bug_reports').select('*').in('user_id', ids).order('created_at', { ascending: false }).limit(LIST_LIMIT);
  if (r.error) return isMissingTable(r.error) ? { setupNeeded: true } : { error: 'Could not load bug reports.' };
  const rows = (r.data || []).filter((x) => ids.includes(x.user_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const bucket = svc.storage?.from('documents');
  const reports = await Promise.all(rows.map(async (x) => {
    let screenshot_url = null;
    if (ownScreenshot(x) && bucket?.createSignedUrl) {
      try { const s = await bucket.createSignedUrl(x.screenshot_path, ttl); screenshot_url = s?.data?.signedUrl || null; } catch { /* link just missing */ }
    }
    return { id: x.id, created_at: x.created_at, user_email: x.user_email, page_url: x.page_url, user_agent: x.user_agent, viewport: x.viewport,
      what_happened: x.what_happened, expected: x.expected, status: x.status || 'new', has_screenshot: !!x.screenshot_path, screenshot_url };
  }));
  return { reports };
}

// Short "iPhone · Safari" style label from a user agent (display only).
export function deviceLabel(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${br}`;
}
