'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { confirmationMatches } from '../lib/accountDeletion';

const card = {
  border: '1px solid var(--danger-border)',
  borderRadius: 12,
  padding: '1rem',
  background: 'var(--danger-bg)',
  marginTop: '1rem',
};
const input = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.75rem',
  fontSize: '1rem',
  borderRadius: 8,
  border: '1px solid var(--danger-border)',
  background: 'var(--surface)',
  color: 'var(--text)',
};
const btn = {
  width: '100%',
  minHeight: 44,
  padding: '0.85rem',
  fontSize: '1rem',
  borderRadius: 8,
  border: 'none',
  marginTop: '0.75rem',
  cursor: 'pointer',
};

async function token() {
  const sb = getSupabase();
  const { data } = await sb.auth.getSession();
  return { sb, access: data?.session?.access_token || '' };
}

export default function DangerZone() {
  const [status, setStatus] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function load() {
    const { access } = await token();
    if (!access) { setStatus({ signedOut: true }); return; }
    const res = await fetch('/api/account/deletion', { headers: { authorization: `Bearer ${access}` }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error || 'Couldn’t load this section.'); return; }
    setStatus(body);
    setError(null);
  }

  useEffect(() => { load().catch(() => setError('Couldn’t load this section.')); }, []);

  async function post(payload) {
    setBusy(true);
    setError(null);
    try {
      const { sb, access } = await token();
      if (!access) { setError('Sign in first.'); return; }
      const res = await fetch('/api/account/deletion', {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Couldn’t finish that.'); return; }
      setDone(body.message || 'Done.');
      if (body.sign_out) {
        try { await sb.auth.signOut(); } catch { /* the sign-in is already gone, or the network dropped */ }
      } else {
        setTyped('');
        await load();
      }
    } catch {
      setError('Couldn’t reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const ready = confirmationMatches(typed, status?.email);
  const pending = status?.pending;

  return (
    <section style={card} data-testid="danger-zone">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0, color: 'var(--danger)' }}>Danger zone</h2>
      {status?.signedOut && <p>Sign in to delete an account.</p>}
      {!status && !error && <p>Loading…</p>}
      {done && <p role="status">{done}</p>}
      {!done && pending && (
        <>
          <p>This company is scheduled to be deleted on {new Date(pending.purge_after).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })}. Sign in again before that date to cancel, or cancel now.</p>
          <button type="button" disabled={busy} onClick={() => post({ intent: 'cancel' })} style={{ ...btn, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}>
            {busy ? 'Cancelling…' : 'Cancel deletion'}
          </button>
        </>
      )}
      {!done && status && !status.signedOut && !pending && (
        <>
          <ul style={{ paddingLeft: '1.1rem', margin: '0.25rem 0 0.75rem' }}>
            {(status.warnings || []).map((line) => <li key={line} style={{ margin: '0.35rem 0' }}>{line}</li>)}
          </ul>
          <label htmlFor="delete-confirm" style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem' }}>
            Type DELETE or your email to confirm
          </label>
          <input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" style={input} />
          <button type="button" data-testid="delete-account-button" disabled={!ready || busy} onClick={() => post({ confirm: typed })}
            style={{ ...btn, background: 'var(--danger-solid)', color: 'var(--on-danger)', opacity: !ready || busy ? 0.55 : 1 }}>
            {busy ? 'Working…' : (status.role === 'owner' ? 'Delete company' : 'Delete my account')}
          </button>
        </>
      )}
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    </section>
  );
}
