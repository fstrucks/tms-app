// Client fetch for /api/packets/*. On 401 it refreshes the Supabase session once and retries, so an access
// token that expired while the tab was in the background (mobile timers pause, auto-refresh misses its
// window) doesn't look like a sign-out. Only a second 401 is reported as { signedOut: true }.
export const SIGNED_OUT_MSG = 'You were signed out. Sign in again; your unsaved changes are kept.';
export function makeApi(getAuth, { fetchImpl = (...a) => fetch(...a) } = {}) {
  async function tokenNow(force) {
    const auth = getAuth(); if (!auth) return null;
    if (force) { const { data } = await auth.refreshSession().catch(() => ({ data: null })); if (data?.session?.access_token) return data.session.access_token; }
    const { data } = await auth.getSession();
    return data?.session?.access_token || null;
  }
  async function call(path, opts = {}, retried = false) {
    const t = await tokenNow(retried);
    if (!t) return retried ? { error: SIGNED_OUT_MSG, status: 401, signedOut: true } : call(path, opts, true);
    let r;
    try { r = await fetchImpl(path, { cache: 'no-store', ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } }); }
    catch { return { error: 'Network problem. Check your connection and try again.', status: 0 }; }
    if (r.status === 401 && !retried) return call(path, opts, true);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if (r.status === 401) return { ...j, error: SIGNED_OUT_MSG, status: 401, signedOut: true };
    return { ...j, error: j.error || 'Something went wrong.', status: r.status };
  }
  return { call, token: () => tokenNow(false) };
}
