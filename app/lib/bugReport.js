// Report a bug: shared limits, context capture and validation (client + /api/bug-reports).
// Table: supabase/migrations/20261018000100_bug_reports.sql (unapplied until Marc OKs it).
export const BUG_MIGRATION = '20261018000100_bug_reports.sql';
export const BUG_LIMITS = { what_happened: 4000, expected: 4000, page_url: 2000, user_agent: 1000, viewport: 40 };
export const SCREENSHOT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']; // = documents bucket
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024; // = documents bucket file_size_limit
export const SETUP_MSG = 'Bug reports aren’t switched on yet. Please text Sam what happened for now. Your words are still here.';
export const BUG_HIDDEN_PREFIXES = ['/login', '/auth', '/forgot-password'];
export const isBugButtonHidden = (pathname = '') => BUG_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export function captureContext(win = typeof window === 'undefined' ? null : window) {
  if (!win) return { page_url: null, user_agent: null, viewport: null };
  return { page_url: String(win.location?.href || ''), user_agent: String(win.navigator?.userAgent || ''),
    viewport: `${win.innerWidth}x${win.innerHeight}${win.devicePixelRatio && win.devicePixelRatio !== 1 ? ` @${win.devicePixelRatio}x` : ''}` };
}

export function checkScreenshot(file) {
  if (!file) return null;
  if (!SCREENSHOT_TYPES.includes(file.type)) return 'Screenshot must be a JPG, PNG, WebP or HEIC image.';
  if (file.size > SCREENSHOT_MAX_BYTES) return 'Screenshot is over 10 MB. Try a smaller one.';
  return null;
}

export function screenshotPath(uid, file, now = Date.now()) {
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' })[file?.type] || 'img';
  return `${uid}/bug-reports/${now}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

// Server-side: build the row. Email + user_id come from the verified token, never the body.
// → { row } | { error }
export function buildBugRow(body, user) {
  const b = body && typeof body === 'object' ? body : {};
  const what = String(b.what_happened ?? '').trim();
  if (!what) return { error: 'Please say what happened.' };
  if (what.length > BUG_LIMITS.what_happened) return { error: '“What happened” is too long (4,000 characters max).' };
  if (String(b.expected ?? '').trim().length > BUG_LIMITS.expected) return { error: '“What did you expect” is too long (4,000 characters max).' };
  let shot = b.screenshot_path ? String(b.screenshot_path) : null;
  if (shot && (!shot.startsWith(`${user.id}/bug-reports/`) || shot.includes('..') || shot.length > 300)) return { error: 'Bad screenshot path.' };
  return { row: {
    user_id: user.id, user_email: clip(user.email, 320), what_happened: what,
    expected: clip(b.expected, BUG_LIMITS.expected), page_url: clip(b.page_url, BUG_LIMITS.page_url),
    user_agent: clip(b.user_agent, BUG_LIMITS.user_agent), viewport: clip(b.viewport, BUG_LIMITS.viewport), screenshot_path: shot } };
}
