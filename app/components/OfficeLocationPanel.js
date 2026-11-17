'use client';
// Dispatch / owner / management: live company shares, remote Stop, and a map of latest points.
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';
import { authedFetch } from '../lib/authedFetch';

const OfficeLocationMap = dynamic(() => import('./OfficeLocationMap'), { ssr: false, loading: () => <div style={{ height: 240, borderRadius: 10, background: 'var(--surface-2)' }} /> });

const s = {
  box: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', margin: '0 0 0.9rem', background: 'var(--surface)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0.5rem 0', borderTop: '1px solid var(--divider)' },
  btn: { minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--primary)', background: 'var(--surface)', color: 'var(--primary)', fontWeight: 700, cursor: 'pointer' },
};

export default function OfficeLocationPanel() {
  const [shares, setShares] = useState(null); // null = loading/hidden
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const res = await authedFetch(sb.auth, '/api/location-share/office');
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.status === 409 && body?.setupNeeded) { setShares(null); return; }
    if (res.status === 403) { setShares(null); return; }
    if (!res.ok) { setError(body?.error || 'Couldn’t load shared locations.'); return; }
    setError(null);
    setShares(body.shares || []);
  }, []);

  useEffect(() => {
    let t = null, live = true;
    const go = () => { if (live && document.visibilityState === 'visible') load(); };
    go();
    t = setInterval(go, 15_000);
    const vis = () => go();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('ph-location-share', go);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('ph-location-share', go); };
  }, [load]);

  async function stop(id) {
    if (busy) return;
    setBusy(id);
    const sb = getSupabase();
    const res = await authedFetch(sb.auth, '/api/location-share/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share_id: id, reason: 'office' }) });
    setBusy(null);
    if (res.ok) {
      setShares((list) => (list || []).filter((x) => x.id !== id));
      window.dispatchEvent(new Event('ph-location-share'));
    } else {
      let body = null; try { body = await res.json(); } catch {}
      setError(body?.error || 'Couldn’t stop sharing.');
    }
  }

  if (shares == null && !error) return null;

  const points = (shares || []).filter((x) => x.lat != null && x.lng != null);

  return (
    <section style={s.box} data-testid="office-location-panel">
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.35rem' }}>Shared locations</h2>
      <p style={{ ...s.muted, margin: '0 0 0.6rem' }}>
        Positions update while a driver has PowerHaul open on their screen. If they switch apps or lock the phone, the last point stays until they come back or the share ends.
      </p>
      {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{error}</p>}
      {shares && shares.length === 0 && <p style={s.muted}>No one is sharing right now.</p>}
      {points.length > 0 && <OfficeLocationMap points={points} />}
      {(shares || []).map((x) => (
        <div key={x.id} style={s.row} data-testid="office-location-row">
          <div>
            <strong>{x.label}</strong>
            {x.load_ref && x.load_id ? <> · <Link href={`/dispatch/${x.load_id}`} style={{ color: 'var(--primary)' }}>{x.load_ref}</Link></> : x.load_ref ? <> · {x.load_ref}</> : null}
            <div style={s.muted}>{x.age}{x.until ? ` · ${x.until}` : ''}</div>
          </div>
          <button type="button" data-testid="office-location-stop" disabled={busy === x.id} onClick={() => stop(x.id)} style={s.btn}>
            {busy === x.id ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      ))}
    </section>
  );
}
