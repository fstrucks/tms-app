'use client';
// Facility page: the shared (all companies) directory entry and every public review. Anonymous: stars, notes and
// dates only. Report sends a review or note to moderation. v2: address + Open in Maps, average wait time (hourly /
// daily bars, aggregate only), and lasting Facility notes.
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getSupabase } from '../../lib/supabase';
import { makeApi } from '../../lib/packetApi';
import { ratingSummary } from '../../lib/facilityReviews';
import { PublicReviewCard } from '../../components/ReviewSummary';
import { facilityAddress, mapsUrl, fmtMinutes, FACILITY_NOTE_MAX, MIN_SAMPLES } from '../../lib/facilityPage';

const { call: api } = makeApi(() => getSupabase()?.auth);
const card = { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', background: 'var(--surface)' };
const muted = { color: 'var(--text-muted)', fontSize: '0.85rem' };

function ReportButton({ id, url = `/api/facility-reviews/${id}/report` }) {
  const [state, setState] = useState(null); // null | 'ask' | 'busy' | 'done' | error text
  const [reason, setReason] = useState('');
  if (state === 'done') return <span style={muted}>Reported. Thanks.</span>;
  if (state === 'ask' || state === 'busy' || (state && state !== 'done')) return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <input aria-label="Why are you reporting this? (optional)" placeholder="Why? (optional)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
        style={{ minHeight: 36, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', padding: '0 8px' }} />
      <button type="button" data-testid="facility-report-send" disabled={state === 'busy'} onClick={async () => {
        setState('busy'); const j = await api(url, { method: 'POST', body: JSON.stringify({ reason }) }); setState(j.error ? j.error : 'done');
      }} style={{ minHeight: 36, borderRadius: 8, border: '1px solid var(--danger-border)', color: 'var(--danger)', background: 'var(--surface)', padding: '0 10px' }}>Send report</button>
      <button type="button" onClick={() => setState(null)} style={{ minHeight: 36, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', padding: '0 10px' }}>Cancel</button>
      {state !== 'ask' && state !== 'busy' && <span role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{state}</span>}
    </span>
  );
  return <button type="button" data-testid="facility-report" onClick={() => setState('ask')} style={{ minHeight: 32, border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer' }}>Report</button>;
}

function WaitTimes({ wait }) {
  const [mode, setMode] = useState('hourly');
  if (!wait) return null;
  const bars = mode === 'hourly' ? wait.hourly : wait.daily;
  const max = Math.max(1, ...bars.map((b) => b.avg));
  const tab = (m, label) => (
    <button type="button" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`wait-${m}`}
      style={{ minHeight: 36, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer',
        background: mode === m ? 'var(--primary)' : 'var(--surface)', color: mode === m ? 'var(--on-primary)' : 'var(--text)' }}>{label}</button>
  );
  return (
    <div style={card} data-testid="facility-wait">
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Average wait time</h2>
      {wait.avg == null ? (
        <p style={{ ...muted, margin: '4px 0 0' }} data-testid="wait-empty">Not enough visits yet. Wait times show once drivers have tapped Arrived and then Picked up or Delivered here at least {MIN_SAMPLES} times.</p>
      ) : (
        <>
          <p style={{ margin: '4px 0 8px' }}><strong>{fmtMinutes(wait.avg)}</strong> <span style={muted}>on site, from {wait.samples} visits (arrived to picked up / delivered)</span></p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>{tab('hourly', 'By hour')}{tab('daily', 'By day')}</div>
          {bars.length === 0 ? <p style={muted}>Not enough visits at any one {mode === 'hourly' ? 'hour' : 'day'} yet.</p> : (
            <div role="list" style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140, overflowX: 'auto' }}>
              {bars.map((b) => (
                <div role="listitem" key={b.bucket} title={`${b.label}: ${fmtMinutes(b.avg)} (${b.samples} visits)`} aria-label={`${b.label}: ${fmtMinutes(b.avg)}`}
                  style={{ flex: '1 0 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{Math.round(b.avg)}</span>
                  <div style={{ width: '70%', height: `${Math.max(4, (b.avg / max) * 100)}px`, background: 'var(--primary)', borderRadius: 4 }} />
                  <span style={{ fontSize: '0.7rem' }}>{b.label}</span>
                </div>
              ))}
            </div>
          )}
          <p style={{ ...muted, margin: '6px 0 0', fontSize: '0.75rem' }}>Minutes on site, by local arrival {mode === 'hourly' ? 'hour' : 'day'}. Times with fewer than {MIN_SAMPLES} visits aren’t shown.</p>
        </>
      )}
    </div>
  );
}

function FacilityNotes({ facilityId, notes, canAdd, setupNeeded }) {
  const [list, setList] = useState(notes || []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (setupNeeded) return <div style={card}><h2 style={{ fontSize: '1rem', margin: 0 }}>Facility notes</h2><p style={muted}>Facility notes need a database update that hasn’t been applied yet.</p></div>;
  async function save() {
    setBusy(true); setErr(null);
    const j = await api(`/api/facilities/${facilityId}/notes`, { method: 'POST', body: JSON.stringify({ body: text }) });
    setBusy(false);
    if (j.error || !j.note) return setErr(j.error || 'Couldn’t save the note.');
    setList((l) => [j.note, ...l]); setText('');
  }
  return (
    <div style={card} data-testid="facility-notes">
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Facility notes</h2>
      <p style={{ ...muted, margin: '2px 0 6px' }}>Lasting info for anyone going here, like check-in rules or “lumper available”. Notes are anonymous.</p>
      {list.length === 0 ? <p style={muted}>No notes yet.</p> : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {list.map((n) => (
            <li key={n.id} data-testid="facility-note" style={{ borderTop: '1px solid var(--divider)', padding: '6px 0' }}>
              <div>{n.body}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ ...muted, flex: 1 }}>{new Date(n.created_at).toLocaleDateString()}</span><ReportButton id={n.id} url={`/api/facility-notes/${n.id}/report`} /></div>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <div style={{ marginTop: 8 }}>
          <textarea aria-label="Add a note" data-testid="facility-note-input" value={text} maxLength={FACILITY_NOTE_MAX} onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Check in at the guard shack. Lumper available." style={{ width: '100%', boxSizing: 'border-box', minHeight: 64, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: 8 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...muted, flex: 1 }}>{text.length}/{FACILITY_NOTE_MAX} · No phone numbers, emails or links.</span>
            <button type="button" data-testid="facility-note-save" disabled={busy || !text.trim()} onClick={save}
              style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600 }}>{busy ? 'Saving…' : 'Add note'}</button>
          </div>
          {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '4px 0 0' }}>{err}</p>}
        </div>
      )}
    </div>
  );
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
      <p style={{ ...muted, margin: 0 }} data-testid="facility-address">{facilityAddress(f) || 'No address saved'}</p>
      {mapsUrl(f) && <p style={{ margin: '2px 0 0.75rem' }}><a data-testid="facility-maps" href={mapsUrl(f)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)' }}>📍 Open in Maps</a></p>}
      <div style={card}>
        <strong style={{ fontSize: '1.1rem' }} data-testid="facility-summary">{ratingSummary(st.avg, st.count)}</strong>
        <p style={{ ...muted, margin: '4px 0 0' }}>Reviews come from drivers and dispatchers on any carrier using the app. Names and companies are never shown.</p>
      </div>
      {tips.length > 0 && <div style={card}><h2 style={{ fontSize: '1rem', margin: 0 }}>Need to know</h2>
        <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>{tips.slice(0, 10).map((r) => <li key={r.id}>{r.need_to_know} <span style={muted}>({new Date(r.updated_at || r.created_at).toLocaleDateString()})</span></li>)}</ul></div>}
      <WaitTimes wait={st.wait} />
      <FacilityNotes facilityId={f.id} notes={st.notes} canAdd={!!st.canAddNote} setupNeeded={!!st.notesSetupNeeded} />
      {st.reviews.length > 0 && <h2 style={{ fontSize: '1rem', margin: '1rem 0 0.5rem' }}>Reviews, newest first</h2>}
      {st.reviews.map((r) => (
        <PublicReviewCard key={r.id} review={r} testId="facility-review" aside={<ReportButton id={r.id} />} />
      ))}
    </main>
  );
}
