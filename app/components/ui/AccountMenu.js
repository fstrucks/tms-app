'use client';

import { useEffect, useId, useRef, useState } from 'react';
import InviteTestersMenuItem from './InviteTestersMenuItem';
import Link from 'next/link';
import { flushSync } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import BugReportsMenuItem from '../BugReportsMenuItem';
import { getSupabase } from '../../lib/supabase';
import { loginHref } from '../../lib/safeNext';
import { openWelcome } from '../../lib/welcome';
import { THEME_CHOICES, THEME_LABELS, readTheme, setTheme } from '../../lib/theme';
import { companyOwnerStatus, cachedOwner } from '../../lib/accountOwner';
import { shouldCloseOnBlur, pressEndDelay } from '../../lib/menuBlur';
// Back to this page after signing in (header Sign in, and after Sign out).
const hereLogin = () => (typeof window === 'undefined' ? '/login' : loginHref(window.location.pathname + window.location.search));

// Account button + menu (email, Sign out). Used in the slim mobile top bar and the desktop top nav.
// Keyboard: Enter/Space opens, arrows/Home/End move, Esc closes and returns focus, closes on focus-out.
export default function AccountMenu({ showEmail = false }) {
  const supabase = getSupabase();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pathname = usePathname();
  const [loginHrefState, setLoginHref] = useState('/login');
  useEffect(() => { setLoginHref(hereLogin()); }, [pathname, user]);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const itemRefs = useRef([]);
  const pressRef = useRef(false); // a pointer press inside the menu is in progress (see lib/menuBlur)
  const menuId = useId();
  // Owner-only items (Invite testers, Bug reports) share one check, re-run when the menu opens and when the
  // session token changes; a "couldn't tell" answer keeps the last value instead of hiding them (QA #78 b).
  const [theme, setThemeState] = useState('auto');
  useEffect(() => { if (open) setThemeState(readTheme()); }, [open]);
  const [owner, setOwner] = useState(false);
  const [authTick, setAuthTick] = useState(0);
  const uid = user?.id || null;
  useEffect(() => {
    if (!uid) { setOwner(false); return undefined; }
    if (cachedOwner(uid)) { setOwner(true); return undefined; }
    let on = true;
    companyOwnerStatus(supabase, uid).then((r) => { if (on && r.definite) setOwner(r.owner); }).catch(() => {});
    return () => { on = false; };
  }, [uid, open, authTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!supabase) return setReady(true);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setReady(true);
      if (event === 'SIGNED_OUT') setOpen(false);
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') setAuthTick((n) => n + 1);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    itemRefs.current.filter(Boolean)[0]?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // A press (mouse, touch or pen) that starts inside the menu: blur during it must not close the menu.
  function notePress(kind) {
    pressRef.current = true;
    const end = () => {
      document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
      document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end);
      setTimeout(() => { pressRef.current = false; }, pressEndDelay(kind));
    };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
  }

  async function signOut() {
    setBusy(true); setErr(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) { console.error('[account] sign out', error); setErr('Sign out failed, please try again.'); }
      else { setUser(null); setOpen(false); router.replace(hereLogin()); } // clear the header now, not on the next auth event
    } catch (e) {
      console.error('[account] sign out', e); setErr('Sign out failed, please try again.');
    } finally { setBusy(false); }
  }

  if (!ready) return <span style={{ width: 44, height: 44, display: 'inline-block' }} aria-hidden="true" />;
  if (!user) {
    return <Link href={loginHrefState} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 0.75rem', color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>Sign in</Link>;
  }

  const email = user.email || 'Account';
  const onKey = (e) => {
    const items = [...(wrapRef.current?.querySelectorAll('[role=menuitem],[role=menuitemradio]') || [])];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') { btnRef.current?.focus(); flushSync(() => setOpen(false)); } // Tab continues from the account button, not from <body>
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}
      onPointerDown={(e) => notePress(e.pointerType || 'mouse')} onTouchStart={() => notePress('touch')}
      onBlur={(e) => { if (shouldCloseOnBlur({ open, focusStaysInside: !!wrapRef.current?.contains(e.relatedTarget), pressInside: pressRef.current })) setOpen(false); }}>
      <button ref={btnRef} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        aria-label={`Account: ${email}`} onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44, minWidth: 44, padding: '0 0.4rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
        <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 999, background: 'var(--primary)', color: 'var(--on-primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14 }}>
          {email[0].toUpperCase()}
        </span>
        {showEmail && <span className="account-email" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>{email}</span>}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Account" onKeyDown={onKey} tabIndex={-1}
          style={{ outline: 'none', position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 1000, minWidth: 220, background: 'var(--surface)', border: '1px solid var(--divider)', borderRadius: 10, boxShadow: '0 8px 24px var(--shadow)', padding: '0.25rem' }}>
          <div style={{ padding: '0.6rem 0.8rem', color: 'var(--text-muted)', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: '1px solid var(--divider)' }}>{email}</div>
          <Link ref={(el) => { itemRefs.current[0] = el; }} href="/account/password" role="menuitem" onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', borderRadius: 8, color: 'var(--text)', textDecoration: 'none' }}>
            {user.user_metadata?.password_set ? 'Change password' : 'Set password'}
          </Link>
          <Link ref={(el) => { itemRefs.current[1] = el; }} href="/company" role="menuitem" onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', borderRadius: 8, color: 'var(--text)', textDecoration: 'none' }}>
            Company profile
          </Link>
          <InviteTestersMenuItem owner={owner} onClick={() => setOpen(false)} style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', borderRadius: 8, color: 'var(--text)', textDecoration: 'none' }} />
          <BugReportsMenuItem owner={owner} onPick={() => setOpen(false)} />
          <Link ref={(el) => { itemRefs.current[2] = el; }} href="/packets" role="menuitem" onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', borderRadius: 8, color: 'var(--text)', textDecoration: 'none' }}>
            Carrier packets
          </Link>
          <div role="group" aria-label="Theme" style={{ padding: '0.35rem 0.8rem 0.5rem' }}>
            <div aria-hidden="true" style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 6, whiteSpace: 'nowrap' }}>Theme</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {THEME_CHOICES.map((t) => (
                <button key={t} type="button" role="menuitemradio" aria-checked={theme === t} data-compact data-theme-choice={t}
                  onClick={() => setThemeState(setTheme(t))}
                  style={{ flex: '1 1 0', minWidth: 0, minHeight: 36, padding: '0 0.25rem', fontSize: 14, whiteSpace: 'nowrap', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: theme === t ? 'var(--primary)' : 'var(--surface)', color: theme === t ? 'var(--on-primary)' : 'var(--text)', fontWeight: theme === t ? 600 : 400 }}>
                  {THEME_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <button ref={(el) => { itemRefs.current[3] = el; }} type="button" role="menuitem" onClick={() => { setOpen(false); openWelcome(); }} style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>Welcome tour</button>
          <button ref={(el) => { itemRefs.current[4] = el; }} type="button" role="menuitem" disabled={busy} onClick={signOut}
            style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: 14, margin: '0.25rem 0.8rem 0.5rem' }}>{err}</p>}
        </div>
      )}
    </div>
  );
}
