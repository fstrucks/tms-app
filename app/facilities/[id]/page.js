'use client';
// Facility page: the shared (all companies) directory entry and every public review. Anonymous: stars, notes and
// dates only. Report sends a review to moderation.
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getSupabase } from '../../lib/supabase';
import { makeApi } from '../../lib/packetApi';
import { fmtStars, starsText } from '../../lib/facilityReviews';

const { call: api } = makeApi(() => getSupabase()?.auth);
const card = { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', background: 'var(--surface)' };
const muted = { color: 'var(--text-muted)', fontSize: '0.85rem' };

function ReportButton({ id }) {
  const [state, setState] = useState(null); // null | 'ask' | 'busy' | 'done' | error text
  const [reason, setReason] = useState('');
  if (state === 'done') return <span style={muted}>Reported. Thanks.</span>;
  if (state === 'ask' || state === 'busy' || (state && state !== 'done')) return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <input aria-label="Why are you reporting this? (optional)" placeholder="Why? (optional)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
        style={{ minHeight: 36, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', padding: '0 8px' }} />
      <button type="button" data-testid="facility-report-send" disabled={state === 'busy'} onClick={async () => {
        setState('busy'); const j = await api(`/api/facility-reviews/${id}/report`, { method: 'POST', body: JSON.stringify({ reason }) }); setState(j.error ? j.error : 'done');
      }} style={{ minHeight: 36, borderRadius: 8, border: '1px solid var(--danger-border)', color: 'var(--danger)', background: 'var(--surface)', padding: '0 10px' }}>Send report</button>
      <button type="button" onClick={() => setState(null)} style={{ minHeight: 36, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', padding: '0 10px' }}>Cancel</button>
      {state !== 'ask' && state !== 'busy' && <span role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{state}</span>}
    </span>
  );
  return <button type="button" data-testid="facility-report" onClick={() => setState('ask')} style={{ minHeight: 32, border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer' }}>Report</button>;
}

export default function FacilityPage() {
  const { id } = useParams();
  const [st, setSt] = useState({ loading: true });
  useEffect(() => { api(`/api/facilities/${id}`).then((j) => setSt(j.error ? { error: j.error } : j)).catch(() => setSt({ error: 'Couldn’t load this facility.' })); }, [id]);
  if (st.loading) return <main style={{ padding: '1rem' }}><p style={muted}>Loading…</p></main>;
  if (st.error) return <main style={{ padding: '1rem' }}><p role="alert" style={{ color: 'var(--danger)' }}>{st.error}</p></main>;
  const f = st.facility;
  const tips = st.reviews.filter((r) => r.need_to_know);
  return (
    <main style={{ padding: '1rem', maxWidth: 760, margin: '0 auto' }} data-testid="facility-page">
      <h1 style={{ fontSize: '1.3rem', margin: '0 0 0.25rem' }}>{f.name}</h1>
      <p style={muted}>{[f.address_line1, [f.city, f.state].filter(Boolean).join(', '), f.zip].filter(Boolean).join(' · ')}</p>
      <div style={card}>
        <strong style={{ fontSize: '1.1rem' }}>{st.count ? `${fmtStars(st.avg)} average · ${st.count} review${st.count === 1 ? '' : 's'}` : 'No reviews yet'}</strong>
        <p style={{ ...muted, margin: '4px 0 0' }}>Reviews come from drivers and dispatchers on any carrier using the app. Names and companies are never shown.</p>
      </div>
      {tips.length > 0 && <div style={card}><h2 style={{ fontSize: '1rem', margin: 0 }}>Need to know</h2>
        <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>{tips.slice(0, 10).map((r) => <li key={r.id}>{r.need_to_know} <span style={muted}>({new Date(r.updated_at || r.created_at).toLocaleDateString()})</span></li>)}</ul></div>}
      {st.reviews.map((r) => (
        <div key={r.id} style={card} data-testid="facility-review">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span aria-label={`${r.stars} of 4 stars`} style={{ color: 'var(--warning)', fontSize: '1.1rem' }}>{starsText(r.stars)}</span>
            <span style={{ ...muted, flex: 1 }}>{new Date(r.created_at).toLocaleDateString()}{r.updated_at && r.updated_at !== r.created_at ? ' (edited)' : ''}</span>
            <ReportButton id={r.id} />
          </div>
          {r.better_note && <p style={{ margin: '6px 0 0' }}><strong>Could be better:</strong> {r.better_note}</p>}
          {r.need_to_know && <p style={{ margin: '6px 0 0' }}><strong>Need to know:</strong> {r.need_to_know}</p>}
        </div>
      ))}
    </main>
  );
}
