// Auto-start location on the Home map panel (Marc, Oct 21). Stores ONLY two on/off flags in this browser's
// localStorage, never a position:
//   ph_location_optin = '1'  after the first successful "Use my location" tap
//   ph_location_auto  = '0'  when the user turns "Auto-start location" off (Account → Settings); absent = on
// Pure, JSX-free (Node tests import it).
export const OPTIN_KEY = 'ph_location_optin';
export const AUTO_KEY = 'ph_location_auto';

const get = (storage, k) => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
const set = (storage, k, v) => { try { if (v == null) storage?.removeItem(k); else storage?.setItem(k, v); } catch { /* private mode */ } };

export function readAutoLocation(storage) {
  const optedIn = get(storage, OPTIN_KEY) === '1';
  const off = get(storage, AUTO_KEY) === '0';
  return { optedIn, enabled: !off };
}
export const markOptedIn = (storage) => set(storage, OPTIN_KEY, '1');
export const setAutoLocation = (storage, on) => set(storage, AUTO_KEY, on ? null : '0');

// perm: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'
//   granted → auto (unless turned off); prompt → auto only after an earlier successful tap (and not turned off).
export function shouldAutoStart(perm, { optedIn = false, enabled = true } = {}) {
  if (!enabled) return false;
  if (perm === 'granted') return true;
  return perm === 'prompt' && optedIn;
}
// Show the "Use my location" button when location isn't running and won't auto-start.
export const showLocationButton = (perm, prefs) => ['prompt', 'unknown', 'granted'].includes(perm) && !shouldAutoStart(perm, prefs);

// navigator.permissions.query with a fallback: missing API / unsupported name → 'prompt' (a tap still works).
export async function queryGeoPermission(nav) {
  if (!nav?.geolocation) return { state: 'unsupported', status: null };
  try {
    if (!nav.permissions?.query) return { state: 'prompt', status: null };
    const st = await nav.permissions.query({ name: 'geolocation' });
    return { state: ['granted', 'denied', 'prompt'].includes(st?.state) ? st.state : 'prompt', status: st || null };
  } catch { return { state: 'prompt', status: null }; }
}

export function deniedHelp(platform) {
  if (platform === 'ios') return 'Location is off for this site. On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → “While Using the App”, or in Safari tap aA → Website Settings → Location → Allow. Then reopen this screen.';
  if (platform === 'android') return 'Location is off for this site. In Chrome tap the icon left of the address (or ⋮ → Settings → Site settings → Location), allow it for this site, and make sure phone Location is on. Then reopen this screen.';
  return 'Location is blocked for this site. Click the icon left of the address bar, allow Location, then reload.';
}
