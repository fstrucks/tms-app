// First-sign-in welcome screen: content + "seen" flag logic. No SQL: the flag lives in Supabase
// auth user_metadata.welcome_seen_at (via auth.updateUser), with a per-user localStorage fallback.
export const WELCOME_KEY = 'powerhaul.welcome.seen.v1';
export const OPEN_WELCOME_EVENT = 'powerhaul:open-welcome';
// Never cover sign-in / password-setup flows (invite links land on /account/password).
export const WELCOME_HIDDEN_PREFIXES = ['/login', '/auth', '/forgot-password', '/account/password'];

export const WELCOME_CARDS = [
  { id: 'what', title: 'What PowerHaul TMS does', lines: [
    'Scan rate confirmations and let PowerHaul read them into loads.',
    'Track loads, mileage, expenses, your truck and weekly numbers in one place.',
    'Build and send carrier packets to brokers.'] },
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
