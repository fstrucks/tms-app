'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AccountMenu from './ui/AccountMenu';
import { getSupabase } from '../lib/supabase';
import { navTabs } from '../lib/dispatchNav';
import { syncAuthCookie } from '../lib/authCookie';
import { dispatcherStatus, shouldRecheck, checkUntilDefinite, rememberRole, recallRole, forgetRole } from '../lib/roleRefresh';

const TABS = [
  { href: '/', label: 'Home', icon: '🏠', match: (p) => p === '/' },
  { href: '/dashboard', label: 'Stats', icon: '📊', match: (p) => p.startsWith('/dashboard') || p.startsWith('/mileage') }, // Mileage lives inside Stats
  { href: '/loads', label: 'Loads', icon: '🚚', match: (p) => p.startsWith('/loads') },
  // Pick 6A (Marc): "Documents" in the desktop nav, "Docs" in the mobile bottom tabs.
  { href: '/documents', label: 'Documents', short: 'Docs', icon: '📄', match: (p) => p.startsWith('/documents') },
  { href: '/expenses', label: 'Expenses', icon: '🧾', match: (p) => p.startsWith('/expenses') },
  { href: '/truck', label: 'Truck', icon: '🚛', match: (p) => p.startsWith('/truck') }, // took Mileage's spot (Marc, Oct 17)
];
const HIDDEN = (p) => p.startsWith('/login');

const blue = 'var(--primary)';

// One shared nav, rendered once from app/layout.js.
//   >= 768px: top nav (brand, tabs, account menu).
//   <  768px: slim top bar (brand + account menu) and the bottom tab bar.
// Which one shows is decided by the .appnav-top / .appnav-mtop / .appnav-bottom media queries in globals.css (CSS only).
export default function AppNav() {
  const pathname = usePathname() || '/';
  const hidden = HIDDEN(pathname);
  // Management / dispatchers: the Loads tab opens the dispatch center (their own Loads list is always empty
  // under own-row RLS). Decided by public.dispatch_context(); before that migration nothing changes.
  // Role state follows auth changes (lib/roleRefresh): re-checked on sign-in / user switch / sign-out, retried while
  // the answer is "couldn't tell", and the last definite answer is kept meanwhile (no Loads ↔ Dispatch flicker).
  const [dispatcher, setDispatcher] = useState(false);
  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return undefined;
    let live = true, uid = null, lastDefinite = true, cancel = null;
    const check = (u) => {
      cancel?.(); cancel = null;
      if (!u) { lastDefinite = true; forgetRole(); if (live) setDispatcher(false); return; }
      lastDefinite = false;
      cancel = checkUntilDefinite(() => dispatcherStatus(sb, u.id), (r) => {
        if (!live || uid !== u.id || !r.definite) return;
        lastDefinite = true; rememberRole(u.id, r.dispatcher); setDispatcher(r.dispatcher);
      });
    };
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      syncAuthCookie(session); // server sets / clears the HttpOnly cookie; every event incl. TOKEN_REFRESHED and sign-out
      const u = session?.user || null;
      const userChanged = (u?.id || null) !== uid;
      uid = u?.id || null;
      if (userChanged) { const known = u ? recallRole(u.id) : false; setDispatcher(known === true); }
      if (shouldRecheck(event, { userChanged, lastDefinite })) setTimeout(() => { if (live && uid === (u?.id || null)) check(u); }, 0);
    });
    // Back on the tab after a failed check (e.g. no signal): try again.
    const onVis = () => { if (document.visibilityState === 'visible' && !lastDefinite && uid) sb.auth.getSession().then(({ data }) => { if (live && data?.session?.user?.id === uid) check(data.session.user); }).catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => { live = false; cancel?.(); sub.subscription.unsubscribe(); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  const tabs = navTabs(TABS, { dispatcher });

  // Reserve space for the bottom bar only when it's rendered.
  useEffect(() => {
    document.body.classList.toggle('has-appnav', !hidden);
    return () => document.body.classList.remove('has-appnav');
  }, [hidden]);

  // Text inputs focused = on-screen keyboard (approximately); CSS hides the bar on phones meanwhile.
  useEffect(() => {
    const isText = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'button', 'submit', 'range', 'color'].includes(el.type)));
    const onIn = (e) => { if (isText(e.target)) document.body.classList.add('kbd-open'); };
    const onOut = () => setTimeout(() => { if (!isText(document.activeElement)) document.body.classList.remove('kbd-open'); }, 0);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); document.body.classList.remove('kbd-open'); };
  }, []);

  if (hidden) return null;

  return (
    <>
      <header className="appnav-top" style={{ borderBottom: '1px solid var(--divider)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 40 }}>
        <nav aria-label="Main" style={{ maxWidth: 1120, margin: '0 auto', padding: '0 var(--gutter)', minHeight: 56, display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'system-ui' }}>
          <Link href="/" style={{ fontWeight: 700, color: 'var(--text)', textDecoration: 'none', marginRight: '1rem', padding: '0.75rem 0', whiteSpace: 'nowrap', flexShrink: 0 }}>PowerHaul TMS</Link>
          {tabs.slice(1).map((t) => {
            const active = t.match(pathname);
            return (
              <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', minHeight: 48, padding: '0 0.75rem', fontSize: '0.9375rem', textDecoration: 'none',
                  color: active ? blue : 'var(--text)', fontWeight: active ? 600 : 400, borderBottom: `2px solid ${active ? blue : 'transparent'}` }}>
                {t.label}
              </Link>
            );
          })}
          <div style={{ marginLeft: 'auto' }}><AccountMenu showEmail /></div>
        </nav>
      </header>

      <header className="appnav-mtop" style={{ borderBottom: '1px solid var(--divider)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 40 }}>
        <div style={{ minHeight: 48, padding: '0 0.5rem 0 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'system-ui' }}>
          <Link href="/" style={{ fontWeight: 700, color: 'var(--text)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>PowerHaul TMS</Link>
          <AccountMenu />
        </div>
      </header>

      <nav className="appnav-bottom" aria-label="Main"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, background: 'var(--surface)', borderTop: '1px solid var(--divider)',
          paddingBottom: 'env(safe-area-inset-bottom)', fontFamily: 'system-ui', boxShadow: '0 -2px 8px var(--shadow)' }}>
        {tabs.map((t) => {
          const active = t.match(pathname);
          return (
            <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} aria-label={t.short ? t.label : undefined}
              style={{ flex: 1, minWidth: 0, height: 'var(--nav-h)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 2, textDecoration: 'none', fontSize: '0.68rem', letterSpacing: '-0.01em', color: active ? blue : 'var(--text)', fontWeight: active ? 600 : 400 }}>
              <span aria-hidden="true" style={{ fontSize: '1.25rem', lineHeight: 1 }}>{t.icon}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{t.short || t.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
