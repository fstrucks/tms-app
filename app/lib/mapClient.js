// Browser side of the load map calls (QA #83 r2). Pure enough to test: fetch, token and sleep are injected.
export const NET_RETRY_DELAY_MS = 1_500;
export const REACH_MSG = 'Couldn’t reach the map just now. It will try again next time you open this load.';

// → the JSON answer, or { state: 'failed', message }. A dropped connection (fetch throws, e.g. ERR_CONNECTION_CLOSED)
// is retried once after a short pause; a 401 refreshes the sign-in once and retries.
export async function callMap({ url, method, fetchImpl = fetch, getToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let netRetried = false, authRetried = false;
  for (let n = 0; n < 4; n++) {
    let res, j;
    try {
      res = await fetchImpl(url, { method, cache: 'no-store', headers: { Authorization: `Bearer ${await getToken(authRetried)}` } });
      j = await res.json().catch(() => null);
    } catch {
      if (!netRetried) { netRetried = true; await sleep(NET_RETRY_DELAY_MS); continue; }
      return { state: 'failed', message: REACH_MSG };
    }
    if (res.status === 401 && !authRetried) { authRetried = true; continue; }
    if (res.ok && j) return j;
    if (!j && !netRetried && res.status >= 500) { netRetried = true; await sleep(NET_RETRY_DELAY_MS); continue; } // non-JSON 5xx (platform error page)
    return { state: 'failed', message: j?.error || (res.status === 401 ? 'Your sign-in expired. Please sign in again.' : 'Couldn’t load the map.') };
  }
  return { state: 'failed', message: REACH_MSG };
}

// "Finding the truck route…" vs a message: never both. Loading only while a step is still to come; any failed or
// retry-later answer ends it. While loading, an older error message is hidden.
export function cardPhase(j, { steps = 0, max = 8 } = {}) {
  if (!j) return { computing: false, message: null };
  if (j.state === 'failed' || j.retryInMs) return { computing: false, message: j.message || null };
  const computing = !!(j.stale && j.next && j.canEdit && steps < max);
  return { computing, message: computing ? null : j.message || null };
}
