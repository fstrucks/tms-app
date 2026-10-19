// Dark mode: Light / Dark / Auto, saved per device in localStorage (no account or database setting).
// Auto follows the OS/phone (prefers-color-scheme) and reacts live. The inline script below runs in <head> before
// paint (no flash of the wrong theme) and sets <html data-theme="light|dark">; colors are CSS custom properties
// in app/globals.css.
export const THEME_KEY = 'powerhaul.theme';
export const THEME_CHOICES = ['light', 'dark', 'auto'];
export const THEME_LABELS = { light: 'Light', dark: 'Dark', auto: 'Auto' };
export const THEME_COLORS = { light: '#ffffff', dark: '#0b1220' }; // = --bg, for <meta name="theme-color">

export const normalizeTheme = (v) => (THEME_CHOICES.includes(v) ? v : 'auto');
export const resolveTheme = (pref, osDark) => (normalizeTheme(pref) === 'auto' ? (osDark ? 'dark' : 'light') : normalizeTheme(pref));

// Runs as-is in the browser before React. Keep it dependency-free and ES5-safe; any failure falls back to the
// OS setting via the prefers-color-scheme rules in globals.css.
export const THEME_INIT_SCRIPT = `(function(){try{
var K=${JSON.stringify(THEME_KEY)},C=${JSON.stringify(THEME_COLORS)},d=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');
function pref(){var v=null;try{v=localStorage.getItem(K)}catch(e){}return v==='light'||v==='dark'?v:'auto'}
function apply(){var p=pref(),t=p==='auto'?(m&&m.matches?'dark':'light'):p;d.setAttribute('data-theme',t);d.style.colorScheme=t;
var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++){if(p==='auto'){var dk=/dark/.test(ms[i].getAttribute('media')||'');ms[i].setAttribute('content',dk?C.dark:C.light)}else ms[i].setAttribute('content',C[t])}}
window.__phApplyTheme=apply;apply();
if(m){var on=function(){if(pref()==='auto')apply()};m.addEventListener?m.addEventListener('change',on):m.addListener&&m.addListener(on)}
window.addEventListener('storage',function(e){if(e.key===K)apply()});
document.addEventListener('DOMContentLoaded',apply);
}catch(e){}})();`;

export function readTheme(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try { return normalizeTheme(storage?.getItem(THEME_KEY)); } catch { return 'auto'; }
}

// Save the choice and re-apply now (the init script's apply also updates theme-color).
export function setTheme(pref, win = typeof window !== 'undefined' ? window : null) {
  const p = normalizeTheme(pref);
  if (!win) return p;
  try { if (p === 'auto') win.localStorage.removeItem(THEME_KEY); else win.localStorage.setItem(THEME_KEY, p); } catch { /* private mode: applies for this page only */ }
  if (typeof win.__phApplyTheme === 'function') win.__phApplyTheme();
  else {
    const t = resolveTheme(p, !!win.matchMedia?.('(prefers-color-scheme: dark)').matches);
    win.document.documentElement.setAttribute('data-theme', t);
    win.document.documentElement.style.colorScheme = t;
  }
  return p;
}
