// Validate a ?next= redirect target. Only same-site paths are allowed: a single leading '/',
// not '//' or '/\', no scheme, no control chars, not /login itself. Anything else -> fallback.
export const DEFAULT_NEXT = '/documents';

export function safeNext(raw, fallback = DEFAULT_NEXT) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return fallback;
  let v = raw;
  // Decode up to 3 times so encoded tricks (%2F%2F, %5C, %252F…) are judged in their final form.
  for (let i = 0; i < 3; i++) {
    let d;
    try { d = decodeURIComponent(v); } catch { return fallback; }
    if (d === v) break;
    v = d;
  }
  if (/[\u0000-\u001f\u007f]/.test(raw + v)) return fallback; // control chars, tabs, newlines
  if (v[0] !== '/' || v[1] === '/' || v[1] === '\\') return fallback;
  if (v.includes('\\')) return fallback;
  // Resolve against a dummy origin: must stay on it.
  let u;
  try { u = new URL(v, 'https://same.invalid'); } catch { return fallback; }
  if (u.origin !== 'https://same.invalid') return fallback;
  if (u.pathname === '/login' || u.pathname.startsWith('/login/')) return fallback;
  const out = u.pathname + u.search + u.hash;
  if (out[1] === '/' || out[1] === '\\') return fallback; // e.g. '/..//evil.com' normalizes to '//evil.com'
  return out;
}

// /login?next=<current path+query>, for links shown to signed-out users.
export function loginHref(current) {
  const n = safeNext(current, '');
  return n ? `/login?next=${encodeURIComponent(n)}` : '/login';
}
