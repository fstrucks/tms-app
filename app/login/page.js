'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { safeNext, nextAfterSignIn, magicLinkRedirect } from '../lib/safeNext';
import { signInWithRetry, isNetworkAuthError, NETWORK_SIGNIN_MSG } from '../lib/signInRetry';
import { useHydrated, fallbackAction, NOJS_MSG } from '../lib/authForms';
import { readCredentials, validateCredentials, submitDisabled } from '../lib/loginForm';
import LegalFooter from '../components/LegalFooter';

const nextParam = () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('next'));

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem' },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid var(--border)' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', marginTop: '0.75rem' },
};

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [usePw, setUsePw] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const pwRef = useRef(null);
  const hydrated = useHydrated();
  const nojs = hydrated && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('nojs') === '1';

  async function handleSubmit(e) {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return setError(supabaseConfigError);
    // Read what's actually in the inputs: autofill / password managers may not have fired onChange.
    const creds = readCredentials(e.currentTarget, { email, password });
    const { email: em, password: pw } = creds;
    if (em !== email) setEmail(em);
    if (usePw && pw !== password) setPassword(pw);
    const invalid = validateCredentials(creds, usePw);
    if (invalid) return setError(invalid);
    setSending(true);
    setError(null);
    try {
      if (usePw) {
        const { data, error } = await signInWithRetry((c) => supabase.auth.signInWithPassword(c), { email: em, password: pw });
        if (error) {
          setError(/invalid/i.test(error.message || '') ? 'Wrong email or password.' : isNetworkAuthError(error) ? NETWORK_SIGNIN_MSG : error.message);
          // back to the password field with its text selected, after the button re-enables
          setTimeout(() => { const el = pwRef.current; if (el) { el.focus(); el.select(); } }, 0);
        }
        else {
          // Backfill the password_set flag for accounts that had a password before it existed.
          if (data?.user && data.user.user_metadata?.password_set !== true) {
            try { await supabase.auth.updateUser({ data: { password_set: true } }); } catch (e) { console.error('[auth] flag', e); }
          }
          window.location.assign(nextAfterSignIn(nextParam(), data?.user?.id || data?.session?.user?.id || null)); // not the previous user's page (QA, Oct 19)
        }
        return;
      }
      const { error } = await supabase.auth.signInWithOtp({
        email: em,
        options: {
          emailRedirectTo: magicLinkRedirect(window.location.origin, nextParam()), // no ?next → Home
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
      setError(isNetworkAuthError(err) ? NETWORK_SIGNIN_MSG : err.message || 'Could not send the sign-in link.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={s.main}>
      <p><Link href="/" style={{ color: 'var(--primary)' }}>← Home</Link></p>
      <h1 style={{ fontSize: '1.5rem' }}>Sign in to PowerHaul TMS</h1>
      {supabaseConfigError && <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>}
      <div style={s.card}>
        {sent ? (
          <>
            <p style={{ color: 'var(--success)', fontWeight: 600 }}>Check your email</p>
            <p>We sent a sign-in link to <strong>{email}</strong>. Open the link on this device (in this browser) to finish signing in.</p>
            <button style={{ ...s.btn, background: 'var(--text-muted)' }} onClick={() => setSent(false)}>Use a different email</button>
          </>
        ) : (
          // noValidate: our own plain message ("Enter your email and password.") instead of the browser's tip,
          // which some phones never show. The fields stay `required` for autofill/accessibility hints.
          <form method="post" action={fallbackAction('/login')} onSubmit={handleSubmit} noValidate data-auth-form="login">
            <label htmlFor="email" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Email</label>
            <input id="email" name="email" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} onInput={(e) => setEmail(e.currentTarget.value)} style={s.input} placeholder="you@example.com" />
            {usePw && (
              <>
                <label htmlFor="password" style={{ display: 'block', margin: '0.75rem 0 0.5rem', fontWeight: 600 }}>Password</label>
                <input id="password" name="password" ref={pwRef} type="password" aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} required autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} onInput={(e) => setPassword(e.currentTarget.value)} style={s.input} />
              </>
            )}
            <p id="login-error" role="alert" aria-live="assertive" style={{ color: 'var(--danger)', margin: error ? undefined : 0 }}>{error || (nojs ? NOJS_MSG : '')}</p>
            {/* Never disabled for empty-looking fields: autofill can fill them without React noticing. Checked on submit. */}
            <button type="submit" disabled={!hydrated || submitDisabled(sending)} style={{ ...s.btn, opacity: !hydrated || submitDisabled(sending) ? 0.6 : 1 }}>
              {sending ? (usePw ? 'Signing in…' : 'Sending…') : (usePw ? 'Sign in' : 'Send magic link')}
            </button>
            {usePw && (
              <p style={{ margin: '0.5rem 0 0' }}>
                <Link href={'/forgot-password' + (email ? '?email=' + encodeURIComponent(email) : '')}
                  style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Forgot password?</Link>
              </p>
            )}
            <button type="button" onClick={() => { setUsePw(!usePw); setError(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--primary)', marginTop: '0.75rem', padding: '0.5rem 0', minHeight: 44 }}>
              {usePw ? 'Email me a sign-in link instead' : 'Sign in with a password instead'}
            </button>
          </form>
        )}
      </div>
      <LegalFooter includeDelete />
    </main>
  );
}
