'use client';
// First-sign-in welcome (shown once, dismissible). Re-open from the account menu ("Welcome tour").
// Flag storage + content: app/lib/welcome.js.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getSupabase } from '../lib/supabase';
import { WELCOME_CARDS, OPEN_WELCOME_EVENT, shouldShowWelcome, markWelcomeSeen, uiBusy, whenUiIdle, qaDelayMs, clearQaDelay } from '../lib/welcome';

// Above any floating UI (Report a bug button z 60, its dialog z 2100, nav z 50).
export const WELCOME_Z = 10000;
const store = () => { try { return window.localStorage; } catch { return null; } };

export default function WelcomeScreen() {
  const supabase = getSupabase();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const closeRef = useRef(null);
  const sheetRef = useRef(null);
  const userRef = useRef(null);
  const [wide, setWide] = useState(false);
  useEffect(() => { const m = window.matchMedia('(min-width: 768px)'); const f = () => setWide(m.matches); f(); m.addEventListener?.('change', f); return () => m.removeEventListener?.('change', f); }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => { userRef.current = session?.user || null; setUser(session?.user || null); });
    return () => sub.subscription.unsubscribe();
  }, []);
  // Auto-open (first run) only when no menu/dialog is open; otherwise wait until the user closes it.
  useEffect(() => {
    if (!shouldShowWelcome({ user, pathname, storage: store() })) return undefined;
    const ss = (() => { try { return window.sessionStorage; } catch { return null; } })();
    const show = () => { if (shouldShowWelcome({ user: userRef.current, pathname, storage: store() })) { clearQaDelay(ss); setOpen(true); } };
    let cancel = () => {};
    const t = setTimeout(() => { cancel = whenUiIdle(show); }, qaDelayMs(ss)); // QA delay: 0 unless set by /dev/welcome-reset
    return () => { clearTimeout(t); cancel(); };
  }, [user, pathname]);
  useEffect(() => {
    const onOpen = () => { if (userRef.current) setOpen(true); };
    window.addEventListener(OPEN_WELCOME_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WELCOME_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    if (!uiBusy()) closeRef.current?.focus(); // never steal focus from an open menu
    const onKey = (e) => {
      if (e.key === 'Escape') { dismiss(); return; }
      if (e.key !== 'Tab' || !sheetRef.current) return; // keep Tab inside the sheet
      const f = [...sheetRef.current.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!sheetRef.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    // Marker for floating UI (e.g. Report a bug) to hide itself while the sheet is open; cleared on close/unmount.
    document.body.dataset.welcomeOpen = '1';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; delete document.body.dataset.welcomeOpen; };
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
    <div ref={sheetRef} data-testid="welcome-screen" role="dialog" aria-modal="true" aria-labelledby="welcome-title"
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      style={{ position: 'fixed', inset: 0, zIndex: WELCOME_Z, fontFamily: 'system-ui', background: 'var(--overlay)', display: 'flex', alignItems: wide ? 'center' : 'flex-end', justifyContent: 'center', padding: wide ? 24 : 0 }}>
      <div style={{ width: '100%', maxWidth: 560, maxHeight: '92dvh', overflowY: 'auto', background: 'var(--surface-2)', borderRadius: wide ? 16 : '16px 16px 0 0', padding: '1rem 1rem calc(1rem + env(safe-area-inset-bottom))', boxSizing: 'border-box', margin: '0 auto', boxShadow: '0 -8px 32px var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 id="welcome-title" style={{ margin: 0, fontSize: '1.35rem' }}>Welcome to PowerHaul TMS</h2>
          <button ref={closeRef} type="button" onClick={dismiss} aria-label="Close welcome"
            style={{ minWidth: 44, minHeight: 44, border: 'none', background: 'transparent', fontSize: 24, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>
        <p style={{ margin: '0.25rem 0 0.75rem', color: 'var(--text-muted)' }}>Thanks for testing. Here’s the 30-second tour.</p>
        {WELCOME_CARDS.map((c, i) => (
          <section key={c.id} data-testid={`welcome-card-${c.id}`}
            style={{ background: c.id === 'fake' ? 'var(--warning-bg)' : 'var(--surface)', border: `1px solid ${c.id === 'fake' ? 'var(--warning-border)' : 'var(--divider)'}`, borderRadius: 12, padding: '0.85rem 1rem', marginBottom: 10 }}>
            <h3 style={{ margin: '0 0 0.4rem', fontSize: '1.05rem' }}><span aria-hidden="true" style={{ color: 'var(--primary)', marginRight: 6 }}>{i + 1}.</span>{c.title}</h3>
            {c.lines && c.lines.map((l) => <p key={l} style={{ margin: '0.2rem 0', color: 'var(--text)', lineHeight: 1.4 }}>{l}</p>)}
            {c.steps && <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
              {c.steps.map((s) => (
                <div key={s.label}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{s.label}</div>
                  <ol style={{ margin: 0, paddingLeft: '1.2rem', color: 'var(--text)', lineHeight: 1.4 }}>{s.lines.map((l) => <li key={l}>{l}</li>)}</ol>
                </div>))}
            </div>}
          </section>
        ))}
        <button type="button" onClick={dismiss} data-testid="welcome-done"
          style={{ width: '100%', minHeight: 48, border: 'none', borderRadius: 10, background: 'var(--primary)', color: 'var(--on-primary)', fontSize: '1rem', fontWeight: 600, cursor: 'pointer', marginTop: 4 }}>Got it, let’s go</button>
        <p style={{ margin: '0.5rem 0 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Open this again any time from the account menu → Welcome tour.</p>
      </div>
    </div>
  );
}
