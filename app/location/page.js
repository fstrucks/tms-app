'use client';
// Start or manage location sharing (Phase 1). Consent required. Web foreground only.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { authedFetch } from '../lib/authedFetch';
import SignInLink from '../components/SignInLink';
import {
  DURATION_HOURS, DEFAULT_DURATION_HOURS, DURATION_LABELS,
  CONSENT_WHO, CONSENT_FOREGROUND, CONSENT_STOP, SETUP_MSG, untilLabel, defaultAutoStopOnDelivered,
  alreadySharingText, officeStopText,
} from '../lib/locationShare';

const s = {
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 520, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', background: 'var(--surface)', margin: '0 0 1rem' },
  muted: { color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.45 },
  label: { display: 'block', fontWeight: 600, margin: '0.8rem 0 0.35rem' },
  field: { width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'inherit', fontSize: '1rem', boxSizing: 'border-box' },
  btn: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700, cursor: 'pointer', fontSize: '1rem' },
  btnOff: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: '1px solid var(--primary)', background: 'var(--surface)', color: 'var(--primary)', fontWeight: 700, cursor: 'pointer' },
};

export default function LocationSharePage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState({ loading: true });
  const [mode, setMode] = useState('timed');
  const [hours, setHours] = useState(DEFAULT_DURATION_HOURS);
  const [loadId, setLoadId] = useState('');
  const [autoStop, setAutoStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  async function load() {
    const res = await authedFetch(supabase.auth, '/api/location-share');
    let body = null; try { body = await res.json(); } catch { body = null; }
    if (res.status === 409 && body?.setupNeeded) { setState({ setup: true }); return; }
    if (!res.ok) { setState({ error: body?.error || 'Couldn’t load location sharing.' }); return; }
    // One-time notice after an office stop: remembered per share id in this browser, so it shows once.
    let notice = body.stopped_notice || null;
    try { if (notice && window.localStorage.getItem('ph_loc_stop_seen') === notice.id) notice = null; else if (notice) window.localStorage.setItem('ph_loc_stop_seen', notice.id); } catch { /* storage off: show it */ }
    setState({ share: body.share, loads: body.loads || [], remind: !!body.remind, notice });
  }

  useEffect(() => { if (user && supabase) load(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickLoad(id) {
    setLoadId(id);
    setAutoStop(defaultAutoStopOnDelivered(id));
  }

  async function start(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    const body = mode === 'until_off' ? { mode: 'until_off' } : { mode: 'timed', duration_hours: hours };
    if (loadId) { body.load_id = loadId; body.auto_stop_on_delivered = autoStop; }
    const res = await authedFetch(supabase.auth, '/api/location-share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await res.json(); } catch { j = null; }
    setBusy(false);
    if (!res.ok) { setMsg(j?.error || 'Couldn’t start sharing.'); if (j?.code === 'already_sharing') load(); return; }
    setState((st) => ({ ...st, share: j.share, notice: null }));
    window.dispatchEvent(new Event('ph-location-share'));
  }

  async function stop() {
    if (busy || !state.share) return;
    setBusy(true); setMsg(null);
    const res = await authedFetch(supabase.auth, '/api/location-share/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share_id: state.share.id }) });
    let j = null; try { j = await res.json(); } catch { j = null; }
    setBusy(false);
    if (!res.ok) { setMsg(j?.error || 'Couldn’t stop sharing.'); return; }
    setState((st) => ({ ...st, share: null }));
    window.dispatchEvent(new Event('ph-location-share'));
  }

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.5rem', marginTop: 0 }}>Share my location</h1>
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={{ color: 'var(--primary)' }}>sign in</SignInLink> to share your location.</p>
        : state.setup ? <p style={s.muted}>{SETUP_MSG}</p>
        : state.error ? <p style={{ color: 'var(--danger)' }}>{state.error}</p>
        : state.loading && !state.loads && !state.share && !state.error && !state.setup ? <p style={s.muted}>Loading…</p>
        : state.share ? (
          <div style={s.card}>
            <p style={{ marginTop: 0 }} data-testid="location-already-sharing"><strong>{alreadySharingText(state.share)}</strong></p>
            <p style={s.muted}>{CONSENT_FOREGROUND}</p>
            <button type="button" data-testid="location-page-stop" disabled={busy} onClick={stop} style={s.btnOff}>{busy ? 'Stopping…' : 'Stop sharing'}</button>
          </div>
        ) : (
          <>
          {state.notice && (
            <p role="status" data-testid="location-office-stop-notice" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 10, padding: '0.7rem 0.85rem', margin: '0 0 1rem' }}>
              {officeStopText(state.notice)}
            </p>
          )}
          <form onSubmit={start} style={s.card}>
            <p style={{ ...s.muted, marginTop: 0 }}>{CONSENT_WHO}</p>
            <p style={s.muted}>{CONSENT_FOREGROUND}</p>
            <p style={s.muted}>{CONSENT_STOP}</p>

            <fieldset style={{ border: 0, padding: 0, margin: '0.75rem 0 0' }}>
              <legend style={{ fontWeight: 600, marginBottom: 6 }}>How long</legend>
              {DURATION_HOURS.map((h) => (
                <label key={h} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, cursor: 'pointer' }}>
                  <input type="radio" name="duration" checked={mode === 'timed' && hours === h} onChange={() => { setMode('timed'); setHours(h); }}
                    style={{ width: 20, height: 20, accentColor: 'var(--primary)' }} />
                  {DURATION_LABELS[h]}{h === DEFAULT_DURATION_HOURS ? ' (recommended)' : ''}
                </label>
              ))}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, cursor: 'pointer' }}>
                <input type="radio" name="duration" data-testid="location-until-off" checked={mode === 'until_off'} onChange={() => setMode('until_off')}
                  style={{ width: 20, height: 20, accentColor: 'var(--primary)' }} />
                {DURATION_LABELS.until_off}
              </label>
            </fieldset>

            <label style={s.label} htmlFor="location-load">Load (optional)</label>
            <select id="location-load" data-testid="location-load" value={loadId} onChange={(e) => pickLoad(e.target.value)} style={s.field}>
              <option value="">No specific load</option>
              {(state.loads || []).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>

            {loadId ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 8, cursor: 'pointer' }}>
                <input type="checkbox" data-testid="location-auto-stop" checked={autoStop} onChange={(e) => setAutoStop(e.target.checked)}
                  style={{ width: 22, height: 22, accentColor: 'var(--primary)' }} />
                Stop when this load is marked delivered
              </label>
            ) : null}

            {msg && <p role="alert" style={{ color: 'var(--danger)' }}>{msg}</p>}
            <div style={{ marginTop: '1rem' }}>
              <button type="submit" data-testid="location-start" disabled={busy} style={s.btn}>{busy ? 'Starting…' : 'Start sharing'}</button>
            </div>
          </form>
          </>
        )}
      <p style={{ marginTop: '1rem' }}><Link href="/" style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Home</Link></p>
    </main>
  );
}
