// Validate a ?next= redirect target. Only same-site paths are allowed: a single leading '/',
// not '//' or '/\', no scheme, no control chars, not /login itself. Anything else -> fallback.
export const DEFAULT_NEXT = '/documents';

export function safeNext(raw, fallback = DEFAULT_NEXT) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return fallback;
  // 1) Validate a decoded copy (up to 3 passes, so %5C, %255C, %09… are seen in final form).
  let v = raw;
  for (let i = 0; i < 3; i++) {
    let d;
    try { d = decodeURIComponent(v); } catch {
      if (i === 0) return fallback; // the raw value itself is malformed
      break; // a later pass hit a literal '%' (e.g. 100%25 -> 100%): nothing more can be hidden
    }
    if (d === v) break;
    v = d;
  }
  if (/[\u0000-\u001f\u007f]/.test(raw + v)) return fallback; // control chars, tabs, newlines
  if (raw.includes('\\') || v.includes('\\')) return fallback;   // any backslash, raw or encoded
  for (const x of [raw, v]) if (x[0] !== '/' || x[1] === '/') return fallback;
  // 2) Return the ORIGINAL (not the decoded copy) as normalized by URL, so %26/%25 survive.
  const origin = 'https://same.invalid';
  let u, dv;
  try { u = new URL(raw, origin); dv = new URL(v, origin); } catch { return fallback; }
  if (u.origin !== origin || dv.origin !== origin) return fallback;
  for (const p of [u.pathname, dv.pathname]) {
    if (p[1] === '/') return fallback; // e.g. '/..//evil.com' normalizes to '//evil.com'
    if (p === '/login' || p.startsWith('/login/')) return fallback;
  }
  return u.pathname + u.search + u.hash;
}

// /login?next=<current path+query>, for links shown to signed-out users.
export function loginHref(current) {
  const n = safeNext(current, '');
  return n ? `/login?next=${encodeURIComponent(n)}` : '/login';
}
