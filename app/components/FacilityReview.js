'use client';
// Facility reviews on the stop card: what other drivers said about the next stop's facility (stars, count, recent
// Need-to-know tips, link to all reviews), and the optional review prompt after "Mark as picked up / delivered".
// Reviews are anonymous: no names or companies anywhere.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { NOTE_MAX, NEED_TO_KNOW_HINT, fmtStars } from '../lib/facilityReviews';
import StarRating from './StarRating';
import { ratingText } from '../lib/facilityPage';

const { call: api } = makeApi(() => getSupabase()?.auth);
const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.95rem', cursor: 'pointer' };
const area = { width: '100%', boxSizing: 'border-box', minHeight: 64, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: 8 };

// Load the facility info for every stop of a load once (map stopId → info). One request per load + stamp, shared
// by every component on the page (stop check-off, stop list, Home stop blocks).
const inflight = new Map();
function fetchLoadFacilities(loadId, stamp) {
  const k = `${loadId}|${stamp ?? ''}`;
  if (!inflight.has(k)) {
    const p = api(`/api/loads/${loadId}/facilities`).catch(() => ({ error: true }));
    inflight.set(k, p); p.then(() => setTimeout(() => inflight.delete(k), 30000));
  }
  return inflight.get(k);
}
export function useLoadFacilities(loadId, stamp) {
  const [map, setMap] = useState({});
  useEffect(() => {
    if (!loadId) return undefined;
    let live = true;
    fetchLoadFacilities(loadId, stamp).then((j) => { if (live && j && !j.error) setMap(j.facilities || {}); }).catch(() => {});
    return () => { live = false; };
  }, [loadId, stamp]);
  return map;
}

// '3.2★ · 5 reviews' next to a stop's facility name (links to the facility page). Nothing when it has no reviews.
export function StopRating({ info }) {
  const t = ratingText(info);
  if (!t) return null;
  return <Link data-testid="stop-rating" href={`/facilities/${info.facility_id}`} style={{ color: 'var(--warning)', fontSize: '0.85rem', fontWeight: 600, marginLeft: 6, textDecoration: 'none', whiteSpace: 'nowrap' }}>{t}</Link>;
}

export function FacilityInfo({ info }) {
  if (!info) return null;
  return (
    <div data-testid="facility-info" style={{ background: 'var(--surface-2, var(--surface))', borderRadius: 8, padding: '6px 10px', margin: '0 0 8px', fontSize: '0.85rem' }}>
      <div><strong>{info.count ? `${fmtStars(info.avg)} · ${info.count} review${info.count === 1 ? '' : 's'}` : 'No reviews yet'}</strong>
        {' '}<Link href={`/facilities/${info.facility_id}`} style={{ color: 'var(--primary)' }}>See facility</Link></div>
      {info.tips?.length > 0 && (
        <ul data-testid="facility-tips" style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
          {info.tips.map((t, i) => <li key={i}>{t.text}</li>)}
        </ul>
      )}
    </div>
  );
}

export function FacilityReviewPrompt({ loadId, stop, onClose }) {
  const [st, setSt] = useState({ loading: true });
  const [form, setForm] = useState({ stars: 0, better_note: '', need_to_know: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/api/loads/${loadId}/stops/${stop.id}/review`).then((j) => {
      if (!live) return;
      if (j.setupNeeded) return setSt({ note: 'Facility reviews need a database update that hasn’t been applied yet.' });
      if (j.state === 'missing') return setSt({ note: j.message || 'This stop can’t be reviewed yet.' });
      if (j.error) return setSt({ note: j.error });
      if (!j.canReview) return setSt({ hidden: true });
      if (j.review) setForm({ stars: j.review.stars, better_note: j.review.better_note || '', need_to_know: j.review.need_to_know || '' });
      setSt({ ready: true, existing: !!j.review });
    }).catch(() => live && setSt({ hidden: true }));
    return () => { live = false; };
  }, [loadId, stop.id]);
  if (st.loading || st.hidden) return null;
  if (st.note) return (
    <div role="status" data-testid="facility-review-empty" style={{ marginTop: 8, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
      {st.note}{' '}
      <button type="button" onClick={onClose} style={{ ...btn, minHeight: 32, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>Close</button>
    </div>
  );
  const place = stop.company_name || (stop.stop_type === 'pickup' ? 'the shipper' : 'the receiver');
  async function save() {
    if (!form.stars && !st.existing) return setErr('Pick 1 to 4 stars.');
    setErr(null); setBusy(true);
    const j = await api(`/api/loads/${loadId}/stops/${stop.id}/review`, { method: 'PUT', body: JSON.stringify({ ...form, stars: form.stars || null }) });
    setBusy(false);
    if (j.error) return setErr(j.error);
    const stars = Number(j.review?.stars) || 0;
    setForm((f) => ({ ...f, stars }));
    setSaved(true); setSt({ ready: true, existing: !!j.review });
  }
  if (saved) return (
    <div role="status" data-testid="facility-review-saved" style={{ marginTop: 8, fontSize: '0.9rem', color: 'var(--success)' }}>
      {form.stars > 0 && <div style={{ marginBottom: 6 }}><StarRating value={form.stars} readOnly testIdPrefix="facility-saved" /></div>}
      {form.stars > 0 ? 'Thanks, your review is saved. It’s posted without your name or company.' : 'Rating cleared. It’s posted without your name or company.'}{' '}
      <button type="button" onClick={() => setSaved(false)} style={{ ...btn, minHeight: 32, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>Edit</button>
      <button type="button" onClick={onClose} style={{ ...btn, minHeight: 32, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>Close</button>
    </div>
  );
  return (
    <div role="group" data-testid="facility-review-prompt" aria-label={`Review ${place}`} style={{ marginTop: 10, border: '1px solid var(--divider)', borderRadius: 10, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1 }}>{st.existing ? 'Your review of' : 'How was'} {place}?</strong>
        <button type="button" aria-label="Not now" data-testid="facility-review-dismiss" onClick={onClose} style={{ ...btn, minHeight: 36, padding: '0 10px' }}>Not now</button>
      </div>
      <p style={{ margin: '2px 0 6px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Optional. Shared with other drivers without your name or company.</p>
      <StarRating value={form.stars} name="Stars" testIdPrefix="facility-star" onChange={(n) => setForm({ ...form, stars: n })} />
      <label style={{ display: 'block', marginTop: 8, fontSize: '0.85rem' }}>What could be better (optional)
        <textarea maxLength={NOTE_MAX} value={form.better_note} onChange={(e) => setForm({ ...form, better_note: e.target.value })} style={area} /></label>
      <label style={{ display: 'block', marginTop: 8, fontSize: '0.85rem' }}>Need to know (optional)
        <textarea maxLength={NOTE_MAX} placeholder={NEED_TO_KNOW_HINT} value={form.need_to_know} onChange={(e) => setForm({ ...form, need_to_know: e.target.value })} style={area} /></label>
      <p style={{ margin: '4px 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>No phone numbers, emails or names, please.</p>
      <button type="button" data-testid="facility-review-save" disabled={busy} onClick={save}
        style={{ ...btn, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600 }}>{busy ? 'Saving…' : st.existing ? 'Save changes' : 'Post review'}</button>
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
