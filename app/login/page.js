'use client';

import { useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem' },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
};

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return setError(supabaseConfigError);
    setSending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + '/documents' },
      });
      if (error) setError(error.message);
      else setSent(true);
    } catch (err) {
      setError(err.message || 'Could not send the sign-in link.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={s.main}>
      <p><Link href="/" style={{ color: '#2563eb' }}>← Home</Link></p>
      <h1 style={{ fontSize: '1.5rem' }}>Sign in</h1>
      {supabaseConfigError && <p style={{ color: '#b91c1c' }}>{supabaseConfigError}</p>}
      <div style={s.card}>
        {sent ? (
          <>
            <p style={{ color: '#15803d', fontWeight: 600 }}>Check your email</p>
            <p>We sent a sign-in link to <strong>{email}</strong>. Open it on this device to continue.</p>
            <button style={{ ...s.btn, background: '#6b7280' }} onClick={() => setSent(false)}>Use a different email</button>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="email" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Email</label>
            <input id="email" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} style={s.input} placeholder="you@example.com" />
            <button type="submit" disabled={sending || !email} style={{ ...s.btn, opacity: sending || !email ? 0.6 : 1 }}>
              {sending ? 'Sending…' : 'Send magic link'}
            </button>
            {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
