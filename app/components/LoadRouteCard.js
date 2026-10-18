'use client';
// Top of the load page: map with pickup/delivery pins and the truck route, plus calculated route miles (PR B).
// Reads the cached route (GET). Only when the server says it's stale (addresses changed / never computed) does it
// ask for a compute (POST), so OpenRouteService isn't called on every page view. Leaflet is lazy-loaded.
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { fmtMiles } from '../lib/mileage';

const RouteMap = dynamic(() => import('./RouteMap'), { ssr: false, loading: () => <div style={{ height: 'clamp(180px, 42vw, 280px)', borderRadius: 10, background: '#f1f5f9' }} /> });

const MAX_STEPS = 8; // matches loadRouteServer.MAX_STEPS
const card = { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.5rem', marginBottom: '0.75rem' };
const muted = { color: '#6b7280', fontSize: '0.85rem' };

export default function LoadRouteCard({ supabase, loadId, stopsKey, onLoadChange, onRouteFilled }) {
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    (async () => {
      const token = async (fresh) => {
        if (fresh) { try { await supabase.auth.refreshSession(); } catch {} }
        return (await supabase.auth.getSession())?.data?.session?.access_token || '';
      };
      // Every answer is JSON; a dropped connection or non-JSON answer becomes a calm "failed" state.
      const call = async (method) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          let res, j;
          try {
            res = await fetch(`/api/loads/${loadId}/map`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${await token(attempt > 0)}` } });
            j = await res.json().catch(() => null);
          } catch { return { state: 'failed', message: 'Couldn’t reach the map just now. It will try again next time you open this load.' }; }
          if (res.status === 401 && attempt === 0) continue; // token just expired: refresh once and retry
          if (res.ok && j) return j;
          return { state: 'failed', message: j?.error || 'Couldn’t load the map.' };
        }
        return { state: 'failed', message: 'Your sign-in expired. Please sign in again.' };
      };
      try {
        let j = await call('GET');
        const before = j.load;
        if (!live) return;
        setSt({ ...j, computing: !!(j.stale && j.canEdit) });
        // One short step per POST (geocode a stop, or the route), so no request runs long (QA #83).
        let steps = 0;
        while (live && j.stale && j.canEdit && j.next && j.state !== 'failed' && steps < MAX_STEPS) {
          steps += 1;
          j = await call('POST');
          if (!live) break;
          if (j.state === 'failed') { const msg = j.message; setSt((cur) => (cur.stops ? { ...cur, computing: false, message: msg } : j)); break; }
          setSt({ ...j, computing: !!(j.stale && j.next && steps < MAX_STEPS) });
        }
        if (live && j.load) onLoadChange?.(j.load);
        // A new route can fill Planned miles: re-fetch the page so Miles/RPM/list never show stale values.
        if (live && steps && j.load && (j.load.total_miles !== before?.total_miles || j.load.calculated_miles !== before?.calculated_miles)) onRouteFilled?.();
      } catch { if (live) setSt({ state: 'failed', message: 'Couldn’t load the map.' }); }
    })();
    return () => { live = false; };
  }, [loadId, stopsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (st.state === 'loading') return null;
  if (st.setupNeeded || st.state === 'setup' || st.state === 'no_key' || st.state === 'failed') {
    return <p data-testid="route-map-note" style={{ ...muted, margin: '0 0 0.75rem' }}>{st.message}</p>;
  }
  if (st.state === 'too_few') return null;
  const pinned = (st.stops || []).filter((s) => s.lat != null);
  const cityOnly = pinned.some((s) => s.precision === 'city');
  return (
    <div style={card} data-testid="load-route-card">
      {pinned.length > 0 ? <RouteMap stops={st.stops} geometry={st.geometry} />
        : <div style={{ height: 120, borderRadius: 10, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', ...muted }}>{st.computing ? 'Finding the route…' : 'No map yet'}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: '0.4rem 0.25rem 0' }}>
        <span style={{ fontSize: '0.9rem' }}>
          {st.computing ? <span style={muted}>Finding the truck route…</span>
            : st.calculated_miles ? <>Truck route <strong data-testid="route-miles">{fmtMiles(st.calculated_miles)}</strong></> : null}
        </span>
        {cityOnly && <span style={muted} data-testid="route-approx">Some pins are approximate (street not found; city or ZIP used)</span>}
      </div>
      {st.message && <p role="status" data-testid="route-message" style={{ color: '#92400e', fontSize: '0.85rem', margin: '0.25rem 0.25rem 0' }}>{st.message}</p>}
    </div>
  );
}
