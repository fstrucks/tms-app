'use client';
// Facility reviews on the stop card: what other drivers said about the next stop's facility (stars, count, recent
// Need-to-know tips, link to all reviews), and the optional review prompt after "Mark as picked up / delivered".
// Reviews are anonymous: no names or companies anywhere.
import { useEffect, useRef, useState } from 'react';
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
      <div><strong>{info.count ? `${fmtStars(info.avg)} · ${info.count} review${info.count === 1 ? '' : 's'}` : 'No ratings yet'}</strong>
        {' '}<Link href={`/facilities/${info.facility_id}`} style={{ color: 'var(--primary)' }}>See facility</Link></div>
      {info.tips?.length > 0 && (
        <ul data-testid="facility-tips" style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
          {info.tips.map((t, i) => <li key={i}>{t.text}</li>)}
        </ul>
      )}
    </div>
  );
}

// mode: undefined = opened by "Review this facility" (Not now just closes)
//       'auto'     = right after the mark (Skip → the 9 AM next-day reminder still comes)
//       'reminder' = the next-day reminder card (Skip → never again)
// In 'auto' / 'reminder' a "Don't ask about this facility again" link mutes the facility. 'auto' is a bottom sheet on phones.
const promptPost = (stopId, action) => api('/api/rating-prompts', { method: 'POST', body: JSON.stringify({ stopId, action }) }).catch(() => ({}));
// Phone layout = the bottom tab bar breakpoint (globals.css). Read on first render so the prompt never renders
// inline and then jumps into a sheet (it only mounts client-side, after "Mark as …").
const PHONE = '(max-width: 767.98px)';
function useNarrow() {
  const [n, setN] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE); const on = () => setN(mq.matches); on();
    mq.addEventListener?.('change', on); return () => mq.removeEventListener?.('change', on);
  }, []);
  return n;
}
const FOCUSABLE = 'button:not([disabled]), textarea, input, select, a[href], [tabindex]:not([tabindex="-1"])';
// The prompt's container. Phone layout + right after "Mark as …": a bottom sheet above the tab bar and the safe-area
// inset, over a dimmed page, with focus kept inside, Escape = Skip, and focus returned to where it was on close.
// Otherwise an inline card with room under it so the floating Report a bug button doesn't cover its controls.
function PromptFrame({ sheet, place, onEscape, children }) {
  const ref = useRef(null);
  const escRef = useRef(onEscape); escRef.current = onEscape;
  useEffect(() => {
    if (!sheet) return undefined;
    const el = ref.current; const prev = document.activeElement;
    (el?.querySelector(FOCUSABLE) || el)?.focus();
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); escRef.current?.(); return; }
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll(FOCUSABLE)]; if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (prev?.isConnected) prev.focus?.(); };
  }, [sheet]);
  if (!sheet) return (
    <div role="group" data-testid="facility-review-prompt" data-above-fab aria-label={`Review ${place}`}
      style={{ marginTop: 10, marginBottom: 'var(--fab-space)', border: '1px solid var(--divider)', borderRadius: 10, padding: 10 }}>{children}</div>
  );
  return (
    <>
      <div aria-hidden="true" data-testid="facility-review-backdrop" style={{ position: 'fixed', inset: 0, bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', zIndex: 70, background: 'var(--overlay)' }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`Review ${place}`} tabIndex={-1} data-testid="facility-review-prompt" data-sheet="true"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', zIndex: 71, outline: 'none',
          maxHeight: '75dvh', overflowY: 'auto', overscrollBehavior: 'contain', boxSizing: 'border-box',
          background: 'var(--surface)', borderTop: '1px solid var(--divider)', borderRadius: '14px 14px 0 0', padding: '12px 14px 14px', boxShadow: '0 -8px 32px var(--shadow)' }}>
        {children}
      </div>
    </>
  );
}
export function FacilityReviewPrompt({ loadId, stop, onClose, mode }) {
  const narrow = useNarrow();
  const asked = mode === 'auto' || mode === 'reminder';
  const sheet = mode === 'auto' && narrow;
  const skip = async () => { if (asked) await promptPost(stop.id, mode === 'auto' ? 'skip' : 'dismiss'); onClose?.(); };
  const mute = async () => { await promptPost(stop.id, 'dismiss_facility'); onClose?.(); };
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
      <button type="button" onClick={onClose} style={{ ...btn, minHeight: 44, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>Close</button>
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
      <button type="button" onClick={() => setSaved(false)} style={{ ...btn, minHeight: 44, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>Edit</button>
      <button type="button" onClick={onClose} style={{ ...btn, minHeight: 44, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>Close</button>
    </div>
  );
  return (
    <PromptFrame sheet={sheet} place={place} onEscape={skip}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1 }}>{st.existing ? 'Your review of' : 'How was'} {place}?</strong>
        <button type="button" aria-label={asked ? 'Skip' : 'Not now'} data-testid="facility-review-dismiss" onClick={skip} style={{ ...btn, minHeight: 44, minWidth: 44, padding: '0 12px' }}>{asked ? 'Skip' : 'Not now'}</button>
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
      {asked && <button type="button" data-testid="facility-review-mute" onClick={mute}
        style={{ ...btn, display: 'block', minHeight: 44, marginTop: 6, border: 'none', background: 'none', color: 'var(--text-muted)', padding: '0 4px', fontSize: '0.85rem', textDecoration: 'underline' }}>Don’t ask about this facility again</button>}
    </PromptFrame>
  );
}
