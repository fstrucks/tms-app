'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import SignInLink from '../../components/SignInLink';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import EldImport from './EldImport';

const main = { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto', minWidth: 0 };

export default function EldImportPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  // Dev-only: /mileage/import?demo=1 shows the UI signed-out (saving disabled) for screenshots.
  const [demo, setDemo] = useState(false);
  useEffect(() => { setDemo(process.env.NODE_ENV !== 'production' && new URLSearchParams(window.location.search).has('demo')); }, []);

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <main style={main}>
      <p style={{ margin: '0 0 0.25rem' }}><Link href="/dashboard?view=mileage" style={{ color: '#2563eb' }}>← Stats · Mileage</Link></p>
      <h1 style={{ fontSize: '1.5rem', marginTop: 0 }}>Import ELD miles</h1>
      {demo ? <EldImport supabase={null} userId={null} />
        : supabaseConfigError ? <p style={{ color: '#b91c1c' }}>{supabaseConfigError}</p>
        : checking ? <p style={{ color: '#6b7280' }}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={{ color: '#2563eb' }}>sign in</SignInLink> to import mileage.</p>
        : <EldImport supabase={supabase} userId={user.id} />}
    </main>
  );
}
