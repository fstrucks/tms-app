// Credential-safe forms. If a form is submitted before React hydrates, the browser does a native submit.
// A form without method/action does GET to the same URL, putting email/password in the address bar,
// history and request logs. Every form with a password, token or sign-in email therefore:
//   - uses method="post" (body, never the URL)
//   - posts to FORM_FALLBACK, a handler that ignores the body and redirects back with ?nojs=1
//   - keeps its submit button disabled until hydrated (useHydrated)

export const FORM_FALLBACK_PATH = '/api/form-fallback';
// Sensitive query keys we never want left in the address bar.
export const SENSITIVE_PARAMS = ['password', 'pass', 'pw', 'new_password', 'confirm', 'token', 'access_token', 'refresh_token'];

export function fallbackAction(back) {
  return `${FORM_FALLBACK_PATH}?back=${encodeURIComponent(back)}`;
}

// Allowed redirect targets for the fallback (fixed list, no open redirect, no echo).
export const FALLBACK_BACK = ['/login', '/forgot-password', '/account/password', '/account/invite'];
export function fallbackTarget(back) {
  const p = FALLBACK_BACK.includes(back) ? back : '/login';
  return `${p}?nojs=1`;
}

// Returns the cleaned search string, or null when nothing sensitive was present.
export function stripSensitiveSearch(search) {
  const q = new URLSearchParams(search || '');
  let hit = false;
  for (const k of [...q.keys()]) if (SENSITIVE_PARAMS.includes(k.toLowerCase())) { q.delete(k); hit = true; }
  // email next to a password is part of the leaked pair; drop it too
  if (hit) q.delete('email');
  if (!hit) return null;
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function scrubLocation() {
  if (typeof window === 'undefined') return;
  const cleaned = stripSensitiveSearch(window.location.search);
  if (cleaned === null) return;
  try { window.history.replaceState(window.history.state, '', window.location.pathname + cleaned + window.location.hash); } catch {}
}

export const NOJS_MSG = 'The page was still loading, so nothing was sent. Please try again.';
