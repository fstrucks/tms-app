'use client';
// Reviews tab: one rating for the shipper (pickup) and one for the receiver (delivery).
// Tap a star to save it. Tap the same star again to clear it. Fake preview data is for the QA page only.
import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { createStarTaps, reviewParties } from '../lib/facilityReviews';
import StarRating from './StarRating';
import { PublicReviewCard, RatingSummaryRow } from './ReviewSummary';

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
  const notesRef = useRef(st.notes || { better_note: '', need_to_know: '' });
  const previewRef = useRef(!!preview);
  const canRef = useRef(!!st.canReview);
  const reviewRef = useRef(null);
  notesRef.current = st.notes || notesRef.current;
  previewRef.current = !!preview;
  canRef.current = !!st.canReview;
  const tapsRef = useRef(null);
  if (!tapsRef.current) {
    tapsRef.current = createStarTaps({
      initial: preview ? (seed?.stars || 0) : 0,
      save: async (n) => {
        if (previewRef.current) return n;
        const notes = notesRef.current || {};
        const j = await api(`/api/loads/${loadId}/stops/${stop.id}/review`, {
          method: 'PUT',
          body: JSON.stringify({ stars: n || null, better_note: notes.better_note || '', need_to_know: notes.need_to_know || '' }),
        });
        if (j.error) throw new Error(j.error);
        reviewRef.current = j.review || null;
        return Number(j.review?.stars) || 0;
      },
    });
  }

  useEffect(() => {
    if (preview) return undefined;
    let live = true;
    api(`/api/loads/${loadId}/stops/${stop.id}/review`).then((j) => {
      if (!live) return;
      if (j.setupNeeded) return setSt({ note: 'Facility reviews need a database update that hasn’t been applied yet.' });
      if (j.error && j.canReview == null && !j.review) return setSt({ note: j.error });
      const stars = Number(j.review?.stars) || 0;
      tapsRef.current.reset(stars);
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

  function onChange(next) {
    if (!canRef.current) return undefined;
    const stars = tapsRef.current.push(next);
    setSt((s) => ({ ...s, stars, busy: true, err: null }));
    tapsRef.current.done().then((result) => {
      if (tapsRef.current.value !== result.value) return;
      const review = reviewRef.current;
      setSt((s) => ({
        ...s,
        stars: result.value,
        saved: result.value > 0,
        busy: false,
        err: result.error || null,
        notes: review && !result.error ? {
          better_note: review.better_note || '',
          need_to_know: review.need_to_know || '',
        } : (s.notes || { better_note: '', need_to_know: '' }),
      }));
    });
    return stars;
  }

  return (
    <section style={card} data-testid={`review-party-${stop.stop_type}`}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>{role}</div>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 8px' }}>{name}</h2>
      {st.loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>Loading…</p>}
      {st.note && <p role="status" style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>{st.note}</p>}
      {st.ready && st.canReview && (
        <>
          <StarRating value={st.stars} onChange={onChange} name={`${role} rating`} testIdPrefix={`review-star-${stop.id}`} />
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

const byNewest = (reviews) => [...(reviews || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

export default function LoadReviews({ load, preview = null }) {
  const parties = reviewParties(load?.stops);
  const facilityKey = parties.map((s) => s.facility_id || '').join(',');
  const [board, setBoard] = useState(() => (preview
    ? { ready: true, rows: preview.summaries || [], reviews: byNewest(preview.list) }
    : { ready: false, rows: [], reviews: [] }));

  useEffect(() => {
    if (preview) return undefined;
    const ids = [...new Set(parties.map((s) => s.facility_id).filter(Boolean))];
    if (!ids.length) {
      setBoard({ ready: true, rows: [], reviews: [] });
      return undefined;
    }
    let live = true;
    Promise.all(ids.map((id) => api(`/api/facilities/${id}`).then((j) => ({ id, j })).catch(() => ({ id, j: { error: true } }))))
      .then((results) => {
        if (!live) return;
        const rows = [];
        const reviews = [];
        const seen = new Set();
        for (const { id, j } of results) {
          if (!j || j.error || !j.facility) continue;
          const stop = parties.find((s) => s.facility_id === id);
          rows.push({ id, name: j.facility.name || stop?.company_name || '', avg: j.avg, count: j.count, href: `/facilities/${id}` });
          for (const r of j.reviews || []) {
            if (!r?.id || seen.has(r.id)) continue;
            seen.add(r.id);
            reviews.push(r);
          }
        }
        setBoard({ ready: true, rows, reviews: byNewest(reviews) });
      });
    return () => { live = false; };
  }, [load?.id, preview, facilityKey]);

  return (
    <div data-testid="load-reviews">
      {board.ready && board.rows.length === 0 && <RatingSummaryRow avg={null} count={0} />}
      {board.rows.map((row) => <RatingSummaryRow key={row.id || row.name} name={row.name} avg={row.avg} count={row.count} href={row.href} />)}
      {!board.ready && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading ratings…</p>}
      <p style={{ margin: '0 0 0.75rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
        Rate the shipper and the receiver. Shared with other drivers without your name or company.
      </p>
      {parties.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No shipper or receiver on this load.</p>}
      {parties.map((stop) => <Row key={stop.id} loadId={load?.id} stop={stop} preview={!!preview} seed={preview?.reviews?.[stop.id]} />)}
      {board.reviews.length > 0 && (
        <div id="review-list" data-testid="review-list">
          {board.reviews.map((r) => <PublicReviewCard key={r.id} review={r} />)}
        </div>
      )}
    </div>
  );
}
