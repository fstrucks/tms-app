'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from './lib/supabase';

const LINKS = [
  ['/documents', 'Documents'],
  ['/loads', 'Loads'],
  ['/mileage', 'Mileage'],
  ['/expenses', 'Expenses'],
  ['/dashboard', 'Dashboard'],
];

const s = {
  main: { padding: '1.25rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  link: { display: 'block', padding: '0.85rem 1rem', border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: '0.6rem', color: '#2563eb', textDecoration: 'none', fontSize: '1.05rem' },
  btn: { padding: '0.5rem 0.9rem', fontSize: '0.9rem', borderRadius: 8, border: 'none', background: '#6b7280', color: '#fff' },
  muted: { color: '#6b7280', fontSize: '0.9rem' },
  error: { color: '#b91c1c' },
};

export default function Home() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signOut() {
    setSigningOut(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) { console.error('sign out', error); setError('Sign out failed, please try again.'); }
    } catch (err) {
      console.error('sign out', err);
      setError('Sign out failed, please try again.');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.6rem' }}>TMS App</h1>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : user ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ ...s.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>Signed in as {user.email}</span>
              <button onClick={signOut} disabled={signingOut} style={{ ...s.btn, opacity: signingOut ? 0.6 : 1 }}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
            {error && <p style={s.error}>{error}</p>}
            <nav>
              {LINKS.map(([href, label]) => <Link key={href} href={href} style={s.link}>{label} →</Link>)}
            </nav>
          </>
        ) : (
          <Link href="/login" style={s.link}>Sign in →</Link>
        )}
    </main>
  );
}
