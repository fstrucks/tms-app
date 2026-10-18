'use client';
// Acts as the signed-in user only: clears THEIR auth user_metadata.welcome_seen_at and this browser's key.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../../lib/supabase';
import { resetWelcome } from '../../lib/welcome';

const btn = { minHeight: 48, padding: '0 1rem', border: 'none', borderRadius: 10, background: '#2563eb', color: '#fff', fontSize: '1rem', fontWeight: 600, cursor: 'pointer', width: '100%' };

export default function WelcomeResetQA() {
  const supabase = getSupabase();
  const [user, setUser] = useState(undefined);
  const [delay, setDelay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!supabase) return setUser(null);
    supabase.auth.getSession().then(({ data }) => setUser(data?.session?.user || null));
  }, []);
  async function go() {
    setBusy(true); setMsg(null);
    const r = await resetWelcome({ supabase, user, storage: window.localStorage, session: window.sessionStorage, delayMs: delay ? 3000 : 0 });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Welcome reset. Go to another page to see it.' } : { ok: false, text: `Couldn’t reset: ${r.error}` });
  }
  return (
    <main style={{ padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem' }}>QA: reset welcome screen</h1>
      <p style={{ color: '#475569' }}>Preview/test only (hidden in production). Shows the first-run welcome again for <strong>your own</strong> account. No database changes.</p>
      {user === undefined ? <p>Checking sign-in…</p> : !user ? <p><Link href="/login?next=/dev/welcome-reset">Sign in</Link> first.</p> : (
        <>
          <p style={{ color: '#475569', wordBreak: 'break-all' }}>Signed in as {user.email}</p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '0.75rem 0', lineHeight: 1.4 }}>
            <input type="checkbox" checked={delay} onChange={(e) => setDelay(e.target.checked)} style={{ width: 22, height: 22 }} data-testid="welcome-reset-delay" />
            <span>Wait 3 seconds before it opens on the next page (time to open a menu or Report a bug first). This tab only, one time.</span>
          </label>
          <button type="button" style={btn} disabled={busy} onClick={go} data-testid="welcome-reset">{busy ? 'Resetting…' : 'Reset welcome screen'}</button>
          {msg && <p role="status" data-testid="welcome-reset-msg" style={{ marginTop: 12, padding: '0.6rem 0.75rem', borderRadius: 8, background: msg.ok ? '#ecfdf5' : '#fef2f2', color: msg.ok ? '#065f46' : '#b91c1c' }}>{msg.text}</p>}
        </>
      )}
    </main>
  );
}
