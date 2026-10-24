'use client';
// Reviews tab: one rating for the shipper (pickup) and one for the receiver (delivery).
// Tap a star to save it. Tap the same star again to clear it. Fake preview data is for the QA page only.
import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { reviewParties } from '../lib/facilityReviews';
import StarRating from './StarRating';

const { call: api } = makeApi(() => getSupabase()?.auth);
const ROLE = { pickup: 'Shipper', delivery: 'Receiver' };
const card = { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', background: 'var(--surface)' };

function Row({ loadId, stop, preview, seed }) {
  const role = ROLE[stop.stop_type] || 'Stop';
  const name = stop.company_name || role;
  const [st, setSt] = useState(() => (preview ? {
    ready: true,
    canReview: seed?.canReview !== false,
    stars: seed?.stars || 0,
    saved: (seed?.stars || 0) > 0,
    notes: { better_note: seed?.better_note || '', need_to_know: seed?.need_to_know || '' },
  } : { loading: true }));

  useEffect(() => {
    if (preview) return undefined;
    let live = true;
    api(`/api/loads/${loadId}/stops/${stop.id}/review`).then((j) => {
      if (!live) return;
      if (j.setupNeeded) return setSt({ note: 'Facility reviews need a database update that hasn’t been applied yet.' });
      if (j.error && j.canReview == null && !j.review) return setSt({ note: j.error });
      const stars = Number(j.review?.stars) || 0;
      setSt({
        ready: true,
        canReview: !!j.canReview,
        stars,
        saved: stars > 0,
        notes: { better_note: j.review?.better_note || '', need_to_know: j.review?.need_to_know || '' },
        blocked: j.state === 'missing' ? (j.message || 'This stop needs a facility name and a city or ZIP before it can be rated.') : null,
      });
    }).catch(() => { if (live) setSt({ note: 'Couldn’t load this rating.' }); });
    return () => { live = false; };
  }, [loadId, stop.id, preview]);

  async function onChange(next) {
    if (!st.canReview || st.busy) return;
    const prev = st;
    setSt({ ...st, stars: next, busy: true, err: null });
    if (preview) {
      setSt({ ...st, stars: next, saved: next > 0, busy: false });
      return;
    }
    const j = await api(`/api/loads/${loadId}/stops/${stop.id}/review`, {
      method: 'PUT',
      body: JSON.stringify({ stars: next || null, better_note: st.notes.better_note, need_to_know: st.notes.need_to_know }),
    });
    if (j.error) return setSt({ ...prev, busy: false, err: j.error });
    const stars = Number(j.review?.stars) || 0;
    setSt({
      ...prev,
      stars,
      saved: stars > 0,
      busy: false,
      err: null,
      notes: { better_note: j.review?.better_note || '', need_to_know: j.review?.need_to_know || '' },
    });
  }

  return (
    <section style={card} data-testid={`review-party-${stop.stop_type}`}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>{role}</div>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 8px' }}>{name}</h2>
      {st.loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>Loading…</p>}
      {st.note && <p role="status" style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>{st.note}</p>}
      {st.ready && st.canReview && (
        <>
          <StarRating value={st.stars} onChange={onChange} disabled={st.busy} name={`${role} rating`} testIdPrefix={`review-star-${stop.id}`} />
          <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: st.saved ? 'var(--success)' : 'var(--text-muted)' }} data-testid="review-saved-rating">
            {st.stars > 0 ? `Saved · ${st.stars} of 4` : 'Not rated. Tap a star to set one. Tap it again to clear it.'}
          </p>
        </>
      )}
      {st.ready && !st.canReview && (
        st.stars > 0
          ? <StarRating value={st.stars} readOnly testIdPrefix={`review-star-${stop.id}`} />
          : <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>{st.blocked || 'You can rate this stop after it is picked up or delivered.'}</p>
      )}
      {st.err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{st.err}</p>}
    </section>
  );
}

export default function LoadReviews({ load, preview = null }) {
  const parties = reviewParties(load?.stops);
  return (
    <div data-testid="load-reviews">
      <p style={{ margin: '0 0 0.75rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
        Rate the shipper and the receiver. Shared with other drivers without your name or company.
      </p>
      {parties.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No shipper or receiver on this load.</p>}
      {parties.map((stop) => <Row key={stop.id} loadId={load?.id} stop={stop} preview={!!preview} seed={preview?.reviews?.[stop.id]} />)}
    </div>
  );
}
