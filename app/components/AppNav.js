'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AccountMenu from './ui/AccountMenu';

const TABS = [
  { href: '/', label: 'Home', icon: '🏠', match: (p) => p === '/' },
  { href: '/dashboard', label: 'Dashboard', short: 'Stats', icon: '📊', match: (p) => p.startsWith('/dashboard') },
  { href: '/loads', label: 'Loads', icon: '🚚', match: (p) => p.startsWith('/loads') },
  // TODO(pick 6, open): "Documents" on desktop vs "Docs" everywhere. Keeping "Docs" until Marc decides.
  { href: '/documents', label: 'Docs', icon: '📄', match: (p) => p.startsWith('/documents') },
  { href: '/expenses', label: 'Expenses', icon: '🧾', match: (p) => p.startsWith('/expenses') },
  { href: '/mileage', label: 'Mileage', icon: '🛣️', match: (p) => p.startsWith('/mileage') },
];
const HIDDEN = (p) => p.startsWith('/login');

const blue = '#2563eb';

// One shared nav, rendered once from app/layout.js.
//   >= 768px: top nav (brand, tabs, account menu).
//   <  768px: slim top bar (brand + account menu) and the bottom tab bar.
// Which one shows is decided by the .appnav-top / .appnav-mtop / .appnav-bottom media queries in globals.css (CSS only).
export default function AppNav() {
  const pathname = usePathname() || '/';
  const hidden = HIDDEN(pathname);

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
      <header className="appnav-top" style={{ borderBottom: '1px solid #e5e7eb', background: '#fff', position: 'sticky', top: 0, zIndex: 40 }}>
        <nav aria-label="Main" style={{ maxWidth: 1120, margin: '0 auto', padding: '0 var(--gutter)', minHeight: 56, display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'system-ui' }}>
          <Link href="/" style={{ fontWeight: 700, color: '#111827', textDecoration: 'none', marginRight: '1rem', padding: '0.75rem 0', whiteSpace: 'nowrap', flexShrink: 0 }}>PowerHaul TMS</Link>
          {TABS.slice(1).map((t) => {
            const active = t.match(pathname);
            return (
              <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', minHeight: 48, padding: '0 0.75rem', fontSize: '0.9375rem', textDecoration: 'none',
                  color: active ? blue : '#374151', fontWeight: active ? 600 : 400, borderBottom: `2px solid ${active ? blue : 'transparent'}` }}>
                {t.label}
              </Link>
            );
          })}
          <div style={{ marginLeft: 'auto' }}><AccountMenu showEmail /></div>
        </nav>
      </header>

      <header className="appnav-mtop" style={{ borderBottom: '1px solid #e5e7eb', background: '#fff', position: 'sticky', top: 0, zIndex: 40 }}>
        <div style={{ minHeight: 48, padding: '0 0.5rem 0 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'system-ui' }}>
          <Link href="/" style={{ fontWeight: 700, color: '#111827', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>PowerHaul TMS</Link>
          <AccountMenu />
        </div>
      </header>

      <nav className="appnav-bottom" aria-label="Main"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, background: '#fff', borderTop: '1px solid #e5e7eb',
          paddingBottom: 'env(safe-area-inset-bottom)', fontFamily: 'system-ui', boxShadow: '0 -2px 8px rgba(0,0,0,0.04)' }}>
        {TABS.map((t) => {
          const active = t.match(pathname);
          return (
            <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} aria-label={t.short ? t.label : undefined}
              style={{ flex: 1, minWidth: 0, height: 'var(--nav-h)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 2, textDecoration: 'none', fontSize: '0.68rem', letterSpacing: '-0.01em', color: active ? blue : '#4b5563', fontWeight: active ? 600 : 400 }}>
              <span aria-hidden="true" style={{ fontSize: '1.25rem', lineHeight: 1 }}>{t.icon}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{t.short || t.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
