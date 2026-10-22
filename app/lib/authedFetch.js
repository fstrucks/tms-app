// fetch with the current Supabase access token; on a 401 refresh the session once and retry.
// getSession() can hand back a stale access token (tab asleep, background refresh missed), which the API
// rejected with "Please sign in again." until a manual sign-out/in (prod, Oct 22).
export async function authedFetch(auth, url, opts = {}, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const send = (t) => fetchImpl(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t || ''}` } });
  const { data } = (await auth?.getSession?.().catch(() => null)) || {};
  let token = data?.session?.access_token;
  if (!token) token = (await refreshed(auth));
  let res = await send(token);
  if (res.status !== 401) return res;
  const fresh = await refreshed(auth);
  if (!fresh || fresh === token) return res;
  return send(fresh);
}
async function refreshed(auth) {
  const r = await auth?.refreshSession?.().catch(() => null);
  return r?.data?.session?.access_token || null;
}
// Server: a network / 5xx failure from auth.getUser isn't a sign-out; don't tell the user to sign in again.
export const isAuthOutage = (e) => !!e && (e.name === 'AuthRetryableFetchError' || e.status === 0 || (e.status >= 500 && e.status < 600));
