'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '../../lib/supabase';
import { safeNext } from '../../lib/safeNext';

// Magic-link landing page. supabase-js picks the session up from the URL; then we go to ?next=
// (validated as a same-site path) or /documents.
export default function AuthCallback() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const next = safeNext(new URLSearchParams(window.location.search).get('next'));
    const supabase = getSupabase();
    if (!supabase) { setFailed(true); return; }
    let done = false;
    const go = () => { if (!done) { done = true; window.location.replace(next); } };
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => { if (session) go(); });
    (async () => {
      const code = new URLSearchParams(window.location.search).get('code');
      if (code) { try { await supabase.auth.exchangeCodeForSession(code); } catch (e) { console.error('[auth] exchange', e); } }
      const { data } = await supabase.auth.getSession();
      if (data?.session) go();
    })();
    const t = setTimeout(() => { if (!done) setFailed(true); }, 8000);
    return () => { clearTimeout(t); sub?.subscription?.unsubscribe(); };
  }, []);
  return (
    <main style={{ padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' }}>
      {failed
        ? <p role="alert">This sign-in link didn't work or has expired. <a href="/login" style={{ color: '#2563eb' }}>Try again</a>.</p>
        : <p aria-live="polite">Signing you in…</p>}
    </main>
  );
}
