// Native app shell config. The app loads the hosted site; the bundled
// mobile/www only holds the offline screen shown when it can't be reached.
// App id and name live in mobile/app-identity.json (see docs/mobile.md to rename).
const identity = require('./mobile/app-identity.json');

const PRODUCTION_URL = 'https://tms-app-two-pi.vercel.app';
// Point a build at a preview deployment: CAP_SERVER_URL=https://... npx cap sync
const serverUrl = (process.env.CAP_SERVER_URL || PRODUCTION_URL).replace(/\/+$/, '');

const allowNavigation = [
  'tms-app-two-pi.vercel.app',
  '*-fst-tms.vercel.app',
  '*.supabase.co',
];
const serverHost = new URL(serverUrl).hostname;
if (!allowNavigation.includes(serverHost)) allowNavigation.push(serverHost);

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: identity.appId,
  appName: identity.appName,
  webDir: 'mobile/www',
  server: {
    url: serverUrl,
    cleartext: false,
    allowNavigation,
    errorPath: 'offline.html',
  },
  ios: { contentInset: 'never', scrollEnabled: true },
  android: { allowMixedContent: false },
  plugins: {
    SplashScreen: { launchAutoHide: false, backgroundColor: '#2563eb', showSpinner: false },
    StatusBar: { overlaysWebView: true, style: 'DEFAULT' },
  },
};

module.exports = config;
