'use client';
// Top of the load page: map with pickup/delivery pins and the truck route, plus calculated route miles (PR B).
// Reads the cached route (GET). Only when the server says it's stale (addresses changed / never computed) does it
// ask for a compute (POST), so OpenRouteService isn't called on every page view. Leaflet is lazy-loaded.
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { fmtMiles } from '../lib/mileage';

const RouteMap = dynamic(() => import('./RouteMap'), { ssr: false, loading: () => <div style={{ height: 'clamp(180px, 42vw, 280px)', borderRadius: 10, background: '#f1f5f9' }} /> });

const card = { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.5rem', marginBottom: '0.75rem' };
const muted = { color: '#6b7280', fontSize: '0.85rem' };

export default function LoadRouteCard({ supabase, loadId, stopsKey, onLoadChange }) {
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    (async () => {
      const t = (await supabase.auth.getSession())?.data?.session?.access_token;
      const call = async (method) => {
        const res = await fetch(`/api/loads/${loadId}/map`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${t || ''}` } });
        const j = await res.json().catch(() => ({}));
        return res.ok ? j : { state: 'failed', message: j.error || 'Couldn’t load the map.' };
      };
      try {
        let j = await call('GET');
        if (live && j.state !== 'failed') setSt({ ...j, computing: !!(j.stale && j.canEdit) });
        if (live && j.stale && j.canEdit) {
          j = await call('POST');
          if (live) setSt(j);
        }
        if (live && j.load) onLoadChange?.(j.load);
        if (live && j.state === 'failed') setSt(j);
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
        {cityOnly && <span style={muted}>Some pins are at the city (street not found)</span>}
      </div>
      {st.message && <p role="status" data-testid="route-message" style={{ color: '#92400e', fontSize: '0.85rem', margin: '0.25rem 0.25rem 0' }}>{st.message}</p>}
    </div>
  );
}
