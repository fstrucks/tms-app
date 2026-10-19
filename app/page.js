'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from './lib/supabase';
import HomeCurrentLoad from './components/HomeCurrentLoad';

const s = {
  main: { padding: '1.25rem var(--gutter)', fontFamily: 'system-ui', margin: '0 auto' },
  narrow: { maxWidth: 480 },
  link: { display: 'block', padding: '0.85rem 1rem', border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: '0.6rem', color: '#2563eb', textDecoration: 'none', fontSize: '1.05rem' },
  muted: { color: '#6b7280', fontSize: '0.9rem' },
  error: { color: '#b91c1c' },
};

export default function Home() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.6rem' }}>PowerHaul TMS</h1>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : user ? (
          <>
            <p style={{ ...s.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>Signed in as {user.email}. Sign out from the account menu (top right).</p>
            <p style={{ lineHeight: 1.5, maxWidth: 640 }}>Welcome back. Use the menu to manage documents, loads, mileage, expenses and your weekly dashboard.</p>
            <HomeCurrentLoad supabase={supabase} user={user} />
          </>
        ) : (
          <div style={s.narrow}><Link href="/login" style={s.link}>Sign in →</Link></div>
        )}
    </main>
  );
}
