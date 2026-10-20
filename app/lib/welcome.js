// First-sign-in welcome screen: content + "seen" flag logic. No SQL: the flag lives in Supabase
// auth user_metadata.welcome_seen_at (via auth.updateUser), with a per-user localStorage fallback.
export const WELCOME_KEY = 'powerhaul.welcome.seen.v1';
export const OPEN_WELCOME_EVENT = 'powerhaul:open-welcome';
// Never cover sign-in / password-setup flows (invite links land on /account/password).
export const WELCOME_HIDDEN_PREFIXES = ['/login', '/auth', '/forgot-password', '/account/password', '/dev/welcome-reset'];

export const WELCOME_CARDS = [
  { id: 'what', title: 'What PowerHaul TMS does', lines: [
    'PowerHaul TMS reads your rate confirmations for you. Just scan one, and it turns into a load automatically. From there, you can track your loads, mileage, expenses, truck and weekly numbers all in one place. When a broker needs your carrier packet, you can put it together and send it right from the app.'] },
  { id: 'home', title: 'Add it to your Home Screen', steps: [
    { label: 'iPhone (Safari)', lines: ['Tap the Share button (square with an arrow).', 'Scroll down and tap “Add to Home Screen”.', 'Tap Add.'] },
    { label: 'Android (Chrome)', lines: ['Tap the ⋮ menu at the top right.', 'Tap “Add to Home screen” (or “Install app”).', 'Tap Add.'] }] },
  { id: 'fake', title: 'Use fake data only', lines: [
    'This is a test version. Please don’t enter real customer, broker, driver or money details.',
    'Made-up names, numbers and documents are perfect.'] },
  { id: 'bugs', title: 'Found a bug? Tell us', lines: [
    'Tap the “Report a bug” button at the bottom of any page.',
    'Say what happened and what you expected. A screenshot helps. We get the page and device automatically.'] },
];

const isHidden = (pathname = '') => WELCOME_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
const localKey = (user) => `${WELCOME_KEY}:${user?.id || 'anon'}`;
function localSeen(storage, user) { try { return !!storage?.getItem(localKey(user)); } catch { return false; } }

export function hasSeenWelcome(user, storage) {
  return !!user?.user_metadata?.welcome_seen_at || localSeen(storage, user);
}

// Auto-open only for a signed-in user who hasn't seen it, and never on sign-in/password pages.
export function shouldShowWelcome({ user, pathname, storage }) {
  if (!user || isHidden(pathname)) return false;
  return !hasSeenWelcome(user, storage);
}

// Save "seen". localStorage first (instant, survives a failed network call), then user_metadata so it
// follows the user to other devices. Never throws. → { saved: 'metadata' | 'local' | 'none', error? }
export async function markWelcomeSeen({ supabase, user, storage, now = () => new Date() }) {
  const at = now().toISOString();
  let local = false;
  try { storage?.setItem(localKey(user), at); local = !!storage; } catch { /* private mode */ }
  if (supabase?.auth?.updateUser && user && !user.user_metadata?.welcome_seen_at) {
    try {
      const { error } = await supabase.auth.updateUser({ data: { welcome_seen_at: at } });
      if (!error) return { saved: 'metadata', at };
      return { saved: local ? 'local' : 'none', at, error: error.message || String(error) };
    } catch (e) { return { saved: local ? 'local' : 'none', at, error: e?.message || String(e) }; }
  }
  return { saved: local ? 'local' : 'none', at };
}

export function openWelcome(win = typeof window === 'undefined' ? null : window) {
  win?.dispatchEvent(new Event(OPEN_WELCOME_EVENT));
}

// Another popup the user opened (account/upload menu, Report-a-bug dialog). The first-run sheet must not
// auto-open over it: that stole focus, closed the menu, and swallowed the next tap.
export const BUSY_UI_SELECTOR = '[role="menu"], [aria-haspopup][aria-expanded="true"], [role="dialog"][aria-modal="true"]:not([data-testid="welcome-screen"]), [role="alertdialog"], [data-ui-busy], body[data-pending-add], body[data-pending-add-check]';
export const uiBusy = (doc = typeof document === 'undefined' ? null : document) => !!doc?.querySelector?.(BUSY_UI_SELECTOR);

// Run cb now if nothing is open, otherwise once the user closes it (MutationObserver, no polling).
// Returns a cancel fn.
export function whenUiIdle(cb, doc = typeof document === 'undefined' ? null : document, MO = typeof MutationObserver === 'undefined' ? null : MutationObserver) {
  if (!uiBusy(doc)) { cb(); return () => {}; }
  if (!MO || !doc?.body) return () => {};
  let done = false;
  const mo = new MO(() => { if (!done && !uiBusy(doc)) { done = true; mo.disconnect(); cb(); } });
  mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'role', 'aria-modal', 'data-ui-busy', 'data-pending-add', 'data-pending-add-check'] });
  return () => { done = true; mo.disconnect(); };
}

// QA only: /dev/welcome-reset (404 in production) can ask for the next auto-open to wait N ms so a tester can
// open a menu first. Stored in sessionStorage (this tab only); cleared when the sheet actually opens.
export const WELCOME_DELAY_KEY = 'powerhaul.welcome.qaDelayMs';
export function qaDelayMs(session) {
  try { const n = Number(session?.getItem(WELCOME_DELAY_KEY)); return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 0; } catch { return 0; }
}
export function clearQaDelay(session) { try { session?.removeItem(WELCOME_DELAY_KEY); } catch { /* ignore */ } }

// QA only: forget "seen" for the signed-in user (own auth metadata + this browser's key). No SQL.
export async function resetWelcome({ supabase, user, storage, session, delayMs = 0 }) {
  if (!supabase || !user) return { error: 'Sign in first.' };
  try { storage?.removeItem(`${WELCOME_KEY}:${user.id}`); } catch { /* private mode */ }
  try { if (delayMs > 0) session?.setItem(WELCOME_DELAY_KEY, String(Math.min(delayMs, 10000))); else clearQaDelay(session); } catch { /* ignore */ }
  try {
    const { error } = await supabase.auth.updateUser({ data: { welcome_seen_at: null } });
    return error ? { error: error.message || String(error) } : { ok: true };
  } catch (e) { return { error: e?.message || String(e) }; }
}
