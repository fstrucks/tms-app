'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import { safeNext, loginHref } from '../../lib/safeNext';
import { validatePassword, MIN_PASSWORD, PASSWORD_PATH } from '../../lib/passwordSetup';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 480, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem' },
  label: { display: 'block', margin: '0.75rem 0 0.5rem', fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
};

function friendly(err) {
  const m = err?.message || '';
  if (err?.code === 'same_password' || /different from the old/i.test(m)) return 'That is your current password. Choose a new one.';
  if (err?.code === 'weak_password' || /weak|at least/i.test(m)) return m || 'That password is too weak.';
  if (err?.code === 'reauthentication_needed' || /reauthenticat/i.test(m)) return 'For security, sign in again (or use “Forgot password?”) and then change your password.';
  if (/session|jwt|not authenticated/i.test(m)) return 'Your sign-in expired. Please sign in again.';
  return m || 'Could not save your password.';
}

export default function SetPasswordPage() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [mode, setMode] = useState('change');
  const [next, setNext] = useState('/documents');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setMode(['setup', 'reset'].includes(q.get('mode')) ? q.get('mode') : 'change');
    setNext(safeNext(q.get('next')));
    const supabase = getSupabase();
    if (!supabase) { setUser(null); return; }
    supabase.auth.getSession().then(({ data }) => setUser(data?.session?.user || null), () => setUser(null));
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    const v = validatePassword(pw, confirm);
    if (v) return setError(v);
    const supabase = getSupabase();
    if (!supabase) return setError(supabaseConfigError);
    setBusy(true); setError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw, data: { password_set: true } });
      if (error) setError(friendly(error));
      else { setDone(true); setPw(''); setConfirm(''); }
    } catch (err) { setError(friendly(err)); } finally { setBusy(false); }
  }

  const title = mode === 'reset' ? 'Choose a new password' : mode === 'setup' ? 'Set your password' : 'Change password';
  const ready = pw.length >= MIN_PASSWORD && confirm.length > 0;

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.5rem' }}>{title}</h1>
      {mode === 'setup' && !done && <p style={{ color: '#4b5563' }}>Set a password so you can sign in with your email and password next time, without waiting for an email link.</p>}
      <div style={s.card}>
        {user === undefined ? <p aria-live="polite">Loading…</p>
          : user === null ? (
            <p role="alert">You need to be signed in to set a password. <Link href={loginHref(PASSWORD_PATH)} style={{ color: '#2563eb' }}>Sign in</Link> or <Link href="/forgot-password" style={{ color: '#2563eb' }}>reset it by email</Link>.</p>
          ) : done ? (
            <>
              <p role="status" style={{ color: '#15803d', fontWeight: 600 }}>Password saved.</p>
              <p>Next time, sign in with <strong>{user.email}</strong> and this password.</p>
              <a href={next} style={{ ...s.btn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>Continue</a>
            </>
          ) : (
            <form onSubmit={onSubmit} noValidate>
              <input type="email" autoComplete="username" value={user.email || ''} readOnly hidden />
              <label htmlFor="new-password" style={{ ...s.label, marginTop: 0 }}>New password</label>
              <input id="new-password" type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={MIN_PASSWORD}
                value={pw} onChange={(e) => setPw(e.target.value)} style={s.input} aria-describedby="pw-hint pw-error" aria-invalid={!!error} />
              <p id="pw-hint" style={{ color: '#6b7280', fontSize: 14, margin: '0.35rem 0 0' }}>At least {MIN_PASSWORD} characters.</p>
              <label htmlFor="confirm-password" style={s.label}>Confirm password</label>
              <input id="confirm-password" type={show ? 'text' : 'password'} autoComplete="new-password" required
                value={confirm} onChange={(e) => setConfirm(e.target.value)} style={s.input} aria-describedby="pw-error" aria-invalid={!!error} />
              <label htmlFor="show-pw" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: '0.25rem' }}>
                <input id="show-pw" type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ width: 20, height: 20 }} />
                Show passwords
              </label>
              <p id="pw-error" role="alert" aria-live="assertive" style={{ color: '#b91c1c', margin: error ? '0.5rem 0 0' : 0 }}>{error || ''}</p>
              <button type="submit" disabled={busy} style={{ ...s.btn, opacity: busy || !ready ? 0.6 : 1 }}>
                {busy ? 'Saving…' : 'Save password'}
              </button>
              {mode === 'setup' && (
                <p style={{ textAlign: 'center', margin: '0.5rem 0 0' }}>
                  <a href={next} style={{ color: '#2563eb', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Skip for now</a>
                </p>
              )}
            </form>
          )}
      </div>
    </main>
  );
}
