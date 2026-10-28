// Public marketing site for pwrstrong.net. Those hosts get the page at "/"; every other host
// (the app, Vercel previews) keeps the app's own "/". The page is also at /site on any host.
export const SITE_HOSTS = ['pwrstrong.net', 'www.pwrstrong.net'];
export const SITE_PATH = '/site';
// Default (current production app) is set in next.config.js; override with NEXT_PUBLIC_APP_URL.
export const SITE_APP_URL = process.env.NEXT_PUBLIC_APP_URL || '';

// Sign in goes straight to the app's /login (the app's "/" only shows another Sign in link when logged out).
export function signInHref(appUrl = SITE_APP_URL) {
  return `${String(appUrl || '').replace(/\/+$/, '')}/login`;
}
export const SITE_CONTACT_EMAIL = 'support@pwrstrong.net'; // placeholder until Marc confirms

export function isSiteHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return SITE_HOSTS.includes(h);
}

// → the path to rewrite to, or null to leave the request alone.
export function siteRewritePath(host, pathname) {
  return pathname === '/' && isSiteHost(host) ? SITE_PATH : null;
}
