'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { safeNext } from '../lib/safeNext';

const nextParam = () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('next'));

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem' },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
};

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [usePw, setUsePw] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const pwRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return setError(supabaseConfigError);
    setSending(true);
    setError(null);
    try {
      if (usePw) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setError(/invalid/i.test(error.message || '') ? 'Wrong email or password.' : error.message);
          // back to the password field with its text selected, after the button re-enables
          setTimeout(() => { const el = pwRef.current; if (el) { el.focus(); el.select(); } }, 0);
        }
        else {
          // Backfill the password_set flag for accounts that had a password before it existed.
          if (data?.user && data.user.user_metadata?.password_set !== true) {
            try { await supabase.auth.updateUser({ data: { password_set: true } }); } catch (e) { console.error('[auth] flag', e); }
          }
          window.location.assign(safeNext(nextParam()));
        }
        return;
      }
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin + '/auth/callback?next=' + encodeURIComponent(safeNext(nextParam())),
          shouldCreateUser: false, // invite-only: no public signups
        },
      });
      if (error) {
        const notInvited = error.code === 'otp_disabled' || error.code === 'signup_disabled'
          || /signups? not allowed|user not found/i.test(error.message || '');
        setError(notInvited
          ? "This email isn't invited yet. Ask the account owner to send you an invite."
          : error.message);
      }
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
      <h1 style={{ fontSize: '1.5rem' }}>Sign in to PowerHaul TMS</h1>
      {supabaseConfigError && <p style={{ color: '#b91c1c' }}>{supabaseConfigError}</p>}
      <div style={s.card}>
        {sent ? (
          <>
            <p style={{ color: '#15803d', fontWeight: 600 }}>Check your email</p>
            <p>We sent a sign-in link to <strong>{email}</strong>. Open the link on this device (in this browser) to finish signing in.</p>
            <button style={{ ...s.btn, background: '#6b7280' }} onClick={() => setSent(false)}>Use a different email</button>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="email" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Email</label>
            <input id="email" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} style={s.input} placeholder="you@example.com" />
            {usePw && (
              <>
                <label htmlFor="password" style={{ display: 'block', margin: '0.75rem 0 0.5rem', fontWeight: 600 }}>Password</label>
                <input id="password" ref={pwRef} type="password" aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} required autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} style={s.input} />
              </>
            )}
            <p id="login-error" role="alert" aria-live="assertive" style={{ color: '#b91c1c', margin: error ? undefined : 0 }}>{error || ''}</p>
            <button type="submit" disabled={sending || !email || (usePw && !password)} style={{ ...s.btn, opacity: sending || !email || (usePw && !password) ? 0.6 : 1 }}>
              {sending ? (usePw ? 'Signing in…' : 'Sending…') : (usePw ? 'Sign in' : 'Send magic link')}
            </button>
            {usePw && (
              <p style={{ margin: '0.5rem 0 0' }}>
                <Link href={'/forgot-password' + (email ? '?email=' + encodeURIComponent(email) : '')}
                  style={{ color: '#2563eb', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Forgot password?</Link>
              </p>
            )}
            <button type="button" onClick={() => { setUsePw(!usePw); setError(null); }}
              style={{ background: 'none', border: 'none', color: '#2563eb', marginTop: '0.75rem', padding: '0.5rem 0', minHeight: 44 }}>
              {usePw ? 'Email me a sign-in link instead' : 'Sign in with a password instead'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
