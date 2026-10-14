'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { recoveryRedirect } from '../lib/passwordSetup';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem' },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
};

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { const e = new URLSearchParams(window.location.search).get('email'); if (e) setEmail(e); }, []);

  async function onSubmit(e) {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return setError(supabaseConfigError);
    setSending(true); setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: recoveryRedirect(window.location.origin) });
      if (error) {
        setError(error.status === 429 || /rate limit/i.test(error.message || '')
          ? 'Too many reset emails. Please wait a few minutes and try again.'
          : error.message || 'Could not send the reset email.');
      } else setSent(true); // same message whether or not the email exists
    } catch (err) {
      setError(err.message || 'Could not send the reset email.');
    } finally { setSending(false); }
  }

  return (
    <main style={s.main}>
      <p><Link href="/login" style={{ color: '#2563eb' }}>← Back to sign in</Link></p>
      <h1 style={{ fontSize: '1.5rem' }}>Reset your password</h1>
      <div style={s.card}>
        {sent ? (
          <>
            <p style={{ color: '#15803d', fontWeight: 600 }} role="status">Check your email</p>
            <p>If <strong>{email}</strong> has an account, we sent a link to set a new password. Open it on this device, in this browser.</p>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <label htmlFor="email" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Email</label>
            <input id="email" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} style={s.input} placeholder="you@example.com" />
            <p role="alert" aria-live="assertive" style={{ color: '#b91c1c', margin: error ? undefined : 0 }}>{error || ''}</p>
            <button type="submit" disabled={sending || !email} style={{ ...s.btn, opacity: sending || !email ? 0.6 : 1 }}>
              {sending ? 'Sending…' : 'Email me a reset link'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
