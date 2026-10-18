'use client';
// First-sign-in welcome (shown once, dismissible). Re-open from the account menu ("Welcome tour").
// Flag storage + content: app/lib/welcome.js.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getSupabase } from '../lib/supabase';
import { WELCOME_CARDS, OPEN_WELCOME_EVENT, shouldShowWelcome, markWelcomeSeen } from '../lib/welcome';

const store = () => { try { return window.localStorage; } catch { return null; } };

export default function WelcomeScreen() {
  const supabase = getSupabase();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const closeRef = useRef(null);
  const userRef = useRef(null);
  const [wide, setWide] = useState(false);
  useEffect(() => { const m = window.matchMedia('(min-width: 768px)'); const f = () => setWide(m.matches); f(); m.addEventListener?.('change', f); return () => m.removeEventListener?.('change', f); }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => { userRef.current = session?.user || null; setUser(session?.user || null); });
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (shouldShowWelcome({ user, pathname, storage: store() })) setOpen(true); }, [user, pathname]);
  useEffect(() => {
    const onOpen = () => { if (userRef.current) setOpen(true); };
    window.addEventListener(OPEN_WELCOME_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WELCOME_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open]);

  function dismiss() {
    setOpen(false);
    const u = userRef.current;
    markWelcomeSeen({ supabase, user: u, storage: store() }).then((r) => {
      if (r.error) console.warn('[welcome] saved locally only:', r.error);
      if (r.saved === 'metadata' && u) userRef.current = { ...u, user_metadata: { ...u.user_metadata, welcome_seen_at: r.at } };
    });
  }

  if (!open) return null;
  return (
    <div data-testid="welcome-screen" role="dialog" aria-modal="true" aria-labelledby="welcome-title"
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, fontFamily: 'system-ui', background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: wide ? 'center' : 'flex-end', justifyContent: 'center', padding: wide ? 24 : 0 }}>
      <div style={{ width: '100%', maxWidth: 560, maxHeight: '92dvh', overflowY: 'auto', background: '#f8fafc', borderRadius: wide ? 16 : '16px 16px 0 0', padding: '1rem 1rem calc(1rem + env(safe-area-inset-bottom))', boxSizing: 'border-box', margin: '0 auto', boxShadow: '0 -8px 32px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 id="welcome-title" style={{ margin: 0, fontSize: '1.35rem' }}>Welcome to PowerHaul TMS</h2>
          <button ref={closeRef} type="button" onClick={dismiss} aria-label="Close welcome"
            style={{ minWidth: 44, minHeight: 44, border: 'none', background: 'transparent', fontSize: 24, cursor: 'pointer', color: '#475569' }}>×</button>
        </div>
        <p style={{ margin: '0.25rem 0 0.75rem', color: '#475569' }}>Thanks for testing. Here’s the 30-second tour.</p>
        {WELCOME_CARDS.map((c, i) => (
          <section key={c.id} data-testid={`welcome-card-${c.id}`}
            style={{ background: c.id === 'fake' ? '#fffbeb' : '#fff', border: `1px solid ${c.id === 'fake' ? '#fde68a' : '#e5e7eb'}`, borderRadius: 12, padding: '0.85rem 1rem', marginBottom: 10 }}>
            <h3 style={{ margin: '0 0 0.4rem', fontSize: '1.05rem' }}><span aria-hidden="true" style={{ color: '#2563eb', marginRight: 6 }}>{i + 1}.</span>{c.title}</h3>
            {c.lines && c.lines.map((l) => <p key={l} style={{ margin: '0.2rem 0', color: '#334155', lineHeight: 1.4 }}>{l}</p>)}
            {c.steps && <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
              {c.steps.map((s) => (
                <div key={s.label}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{s.label}</div>
                  <ol style={{ margin: 0, paddingLeft: '1.2rem', color: '#334155', lineHeight: 1.4 }}>{s.lines.map((l) => <li key={l}>{l}</li>)}</ol>
                </div>))}
            </div>}
          </section>
        ))}
        <button type="button" onClick={dismiss} data-testid="welcome-done"
          style={{ width: '100%', minHeight: 48, border: 'none', borderRadius: 10, background: '#2563eb', color: '#fff', fontSize: '1rem', fontWeight: 600, cursor: 'pointer', marginTop: 4 }}>Got it, let’s go</button>
        <p style={{ margin: '0.5rem 0 0', textAlign: 'center', color: '#64748b', fontSize: 13 }}>Open this again any time from the account menu → Welcome tour.</p>
      </div>
    </div>
  );
}
