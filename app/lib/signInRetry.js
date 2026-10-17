// Client-safe. A cold preview/Supabase edge can drop the very first sign-in request ("Failed to fetch").
// Retry exactly once on a network failure before showing an error. Wrong-password and other auth errors
// are returned straight away (never retried, so we don't double-count failed attempts).
export function isNetworkAuthError(e) {
  if (!e) return false;
  if (e.name === 'AuthRetryableFetchError') return true; // supabase-js wraps fetch TypeErrors as this
  if (e instanceof TypeError || e.name === 'TypeError') return true; // thrown fetch failure
  return /failed to fetch|load failed|networkerror|network request failed/i.test(e.message || '');
}

export async function signInWithRetry(signIn, creds, { delayMs = 600, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let first;
  try {
    first = await signIn(creds);
    if (!isNetworkAuthError(first?.error)) return first;
  } catch (e) {
    if (!isNetworkAuthError(e)) throw e;
  }
  await wait(delayMs);
  return signIn(creds); // second failure (returned or thrown) goes to the caller's normal error handling
}

export const NETWORK_SIGNIN_MSG = 'Couldn’t reach the sign-in server. Check your connection and try again.';
