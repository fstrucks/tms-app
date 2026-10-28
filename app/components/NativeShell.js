'use client';

// Native app only (iOS/Android): back button, status bar colours, splash hide, and the
// html.native-app class used for safe-area padding. Renders nothing; does nothing in a browser.
import { useEffect } from 'react';
import { isNative, backAction } from '../lib/native';

export default function NativeShell() {
  useEffect(() => {
    if (!isNative()) return undefined;
    let stop = false;
    const cleanups = [];
    const root = document.documentElement;
    root.classList.add('native-app');

    (async () => {
      const [{ App }, { StatusBar, Style }, { SplashScreen }] = await Promise.all([
        import('@capacitor/app'), import('@capacitor/status-bar'), import('@capacitor/splash-screen'),
      ]);
      if (stop) return;

      const sync = () => StatusBar.setStyle({ style: root.getAttribute('data-theme') === 'dark' ? Style.Dark : Style.Light }).catch(() => {});
      sync();
      const obs = new MutationObserver(sync);
      obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
      cleanups.push(() => obs.disconnect());

      const sub = await App.addListener('backButton', ({ canGoBack }) => {
        const a = backAction({ pathname: window.location.pathname, canGoBack });
        if (a === 'exit') App.exitApp();
        else if (a === 'back') window.history.back();
        else window.location.assign('/');
      });
      cleanups.push(() => sub.remove());

      SplashScreen.hide().catch(() => {});
    })().catch((err) => console.warn('Native setup failed', err));

    return () => { stop = true; cleanups.forEach((f) => f()); root.classList.remove('native-app'); };
  }, []);
  return null;
}
