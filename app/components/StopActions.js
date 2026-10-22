'use client';
// Per-stop check-off (PR #115) for the Home current-load card and the load page: "Picked up" / "Delivered" / "Done"
// for the next stop, "Skip to next stop", and Undo for the last one marked. Confirm-on-tap. Hidden before the
// stops.completed_at migration, for viewers who can't act, and on loads without stops. Server enforces roles.
import { useRef, useState } from 'react';
import { FacilityInfo, FacilityReviewPrompt, useLoadFacilities } from './FacilityReview';
import { isReviewableStop } from '../lib/facilityReviews';
import { nextStopIndex, STOP_LABEL } from '../lib/homeCurrentLoad';
import { sortedStops } from '../lib/loadTabs';
import { supportsStopCompletion, canCompleteStops, stopActionLabel, stopDoneLabel, lastCompletedStop, allStopsDone, isStopDone, DELIVER_FROM, toLocalInput, fromLocalInput, supportsArrival, isArrived, arriveLabel } from '../lib/stopProgress';
import StopDelays from './StopDelays';

async function post(supabase, loadId, stopId, action, extra = {}) {
  try {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch(`/api/loads/${loadId}/stops/${stopId}`, { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.session?.access_token || ''}` }, body: JSON.stringify({ action, ...extra }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok && j.stop?.id) return { ok: true, ...j };
    return { ok: false, status: res.status, ...j, error: j.error || 'That didn’t save. Please try again.' };
  } catch { return { ok: false, error: 'Couldn’t reach the server. Check your connection and try again.' }; }
}

// Apply a server result to a load object (stop row + maybe status).
export function applyStopResult(load, r) {
  if (!load || !r?.stop) return load;
  return { ...load, ...(r.status ? { status: r.status } : {}), stops: (load.stops || []).map((x) => (x.id === r.stop.id ? { ...x, ...r.stop } : x)) };
}

export const TAP_COOLDOWN_MS = 800;

export default function StopActions({ supabase, load, userId, role, onChange, onRefresh, now }) {
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // one confirm at a time: 'done' | 'skip' | null
  const [when, setWhen] = useState(''); // actual time for the confirm (datetime-local, device time), defaults to now
  const [edit, setEdit] = useState({}); // stopId → datetime-local value being edited
  const [reviewStop, setReviewStop] = useState(null); // stop to review after picked up / delivered (optional prompt)
  const facilities = useLoadFacilities(load?.id, load?.stops?.length);
  const busyRef = useRef(false); // a second tap while a save runs is ignored (state updates lag a fast double tap)
  const coolUntil = useRef(0);   // after a save the next stop's button lands under the finger: ignore taps briefly
  const tapOk = () => !busyRef.current && Date.now() >= coolUntil.current;
  if (hidden || !load || !supportsStopCompletion(load) || !canCompleteStops(role ?? load.viewer_role ?? 'owner', load, userId)) return null;
  const st = sortedStops(load);
  const done = allStopsDone(load);
  const target = done ? null : st[nextStopIndex(load, now)];
  const last = lastCompletedStop(load);
  const open = st.filter((x) => !isStopDone(x));
  const isLast = target && open.length === 1;
  const n = target ? st.indexOf(target) + 1 : 0;

  async function act(stop, action, extra) {
    if (!tapOk()) return false;
    busyRef.current = true;
    setErr(null); setBusy(true);
    const r = await post(supabase, load.id, stop.id, action, extra);
    busyRef.current = false; coolUntil.current = Date.now() + TAP_COOLDOWN_MS;
    setBusy(false); setPending(null);
    if (r.setupNeeded) { setErr('Stop check-off isn’t available on the server yet. Nothing was saved.'); return false; } // was a silent hide (prod Oct 20)
    if (!r.ok) { setErr(r.error); return false; }
    onChange?.(applyStopResult(load, r)); // the re-read server row (also for "already done": treated as success)
    if (action === 'done' && !r.already && ['pickup', 'delivery'].includes(stop.stop_type)) setReviewStop(r.stop || stop); else if (action === 'undo') setReviewStop(null);
    try { onRefresh?.(); } catch (e) { console.error('[stops] refresh', e); } // then re-read the whole load
    return true;
  }
  const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer' };
  const pri = { ...btn, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' };
  const sec = { ...btn, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' };
  const label = target ? stopActionLabel(target) : '';
  const question = pending === 'skip' ? `Skip stop ${n} and go to the next stop?` : pending === 'arrive' ? `${arriveLabel(target)} (stop ${n})?` : `Mark stop ${n} as ${stopDoneLabel(target).toLowerCase()}?`;
  const arrival = supportsArrival(load); // before migration 20261022170000 the Arrived step is hidden
  const canArrive = arrival && target && !isArrived(target);
  const fmtT = (iso) => new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const timeRows = st.flatMap((x) => [
    ...(arrival && x.arrived_at ? [{ x, field: 'arrived', iso: x.arrived_at, label: arriveLabel(x) }] : []),
    ...(x.completion === 'done' ? [{ x, field: 'completed', iso: x.completed_at, label: stopDoneLabel(x) }] : []),
  ]);
  return (
    <div data-testid="stop-actions" style={{ borderTop: '1px solid var(--divider)', marginTop: 12, paddingTop: 10 }}>
      {target ? (
        <>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 6 }}>
            Stop {n} of {st.length} · {STOP_LABEL(target)}{target.company_name ? ` · ${target.company_name}` : ''}
          </div>
          <FacilityInfo info={facilities[target.id]} />
          {arrival && isArrived(target) && (
            <div data-testid="stop-arrived" style={{ fontSize: '0.85rem', color: 'var(--success)', fontWeight: 600, marginBottom: 6 }}>
              ✓ Arrived · {fmtT(target.arrived_at)}
              <button type="button" data-testid="stop-undo-arrive" disabled={busy || !!pending} onClick={() => act(target, 'undo_arrive')}
                style={{ ...btn, minHeight: 32, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 6px', fontSize: '0.85rem' }}>Undo arrived</button>
            </div>
          )}
          {pending ? (
            <div role="group" data-testid="stop-confirm" aria-label={question} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ flexBasis: '100%', fontWeight: 600, color: 'var(--text)' }}>{question}</span>
              {(pending === 'done' || pending === 'arrive') && (
                <label style={{ flexBasis: '100%', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{pending === 'arrive' ? 'Arrived' : stopDoneLabel(target)} at{' '}
                  <input type="datetime-local" data-testid="stop-time" aria-label={`${pending === 'arrive' ? 'Arrived' : stopDoneLabel(target)} date and time`} value={when} onChange={(e) => setWhen(e.target.value)}
                    style={{ minHeight: 40, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' }} />
                </label>
              )}
              <button type="button" data-testid="stop-confirm-yes" disabled={busy} style={pri} onClick={() => act(target, pending, (pending === 'done' || pending === 'arrive') && when ? { at: fromLocalInput(when) } : undefined)}>
                {busy ? 'Saving…' : pending === 'skip' ? 'Yes, skip' : pending === 'arrive' ? 'Yes, arrived' : `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`}</button>
              <button type="button" data-testid="stop-confirm-cancel" disabled={busy} style={sec} onClick={() => setPending(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {canArrive && <button type="button" data-testid="stop-arrive" disabled={busy} style={pri} onClick={() => { if (!tapOk()) return; setErr(null); setWhen(toLocalInput(new Date().toISOString())); setPending('arrive'); }}>{arriveLabel(target)}</button>}
              <button type="button" data-testid="stop-mark" disabled={busy} style={canArrive ? sec : pri} onClick={() => { if (!tapOk()) return; setErr(null); setWhen(toLocalInput(new Date().toISOString())); setPending('done'); }}>{label}</button>
              {!isLast && <button type="button" data-testid="stop-skip" disabled={busy} style={sec} onClick={() => { if (!tapOk()) return; setErr(null); setPending('skip'); }}>Skip to next stop</button>}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ fontSize: '0.9rem', color: 'var(--success)', fontWeight: 600 }}>All stops done.</div>
          {/* Last stop checked off but the load isn't Delivered yet (e.g. marked before this rule existed). */}
          {DELIVER_FROM.includes(load.status) && last && (
            <button type="button" data-testid="stop-deliver-load" disabled={busy} style={{ ...pri, marginTop: 8 }} onClick={() => act(last, 'deliver')}>
              {busy ? 'Saving…' : 'Mark load delivered'}</button>
          )}
        </>
      )}
      {/* Undo stays for the last completed stop, including after the final delivery ("All stops done"). */}
      {last && (
        <button type="button" data-testid="stop-undo" disabled={busy || !!pending} onClick={() => act(last, 'undo')}
          style={{ ...btn, marginTop: 8, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>
          Undo {last.completion === 'skipped' ? 'skip' : `“${stopDoneLabel(last)}”`} (stop {st.indexOf(last) + 1})
        </button>
      )}
      {/* Adjust arrived / picked up / delivered times already recorded (e.g. tapped late). Skipped stops have no time. */}
      {timeRows.length > 0 && (
        <details data-testid="stop-times-edit" style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', minHeight: 32, color: 'var(--primary)', fontSize: '0.9rem' }}>Adjust stop times</summary>
          {timeRows.map(({ x, field, iso, label: l }) => {
            const k = `${x.id}:${field}`;
            const v = edit[k] ?? toLocalInput(iso);
            return (
              <div key={k} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: '0.85rem', minWidth: 140 }}>Stop {st.indexOf(x) + 1} · {l}</span>
                <input type="datetime-local" aria-label={`Stop ${st.indexOf(x) + 1} ${l} time`} value={v} disabled={busy}
                  onChange={(e) => setEdit((m) => ({ ...m, [k]: e.target.value }))}
                  style={{ minHeight: 40, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' }} />
                <button type="button" data-testid="stop-time-save" style={sec} disabled={busy || v === toLocalInput(iso)}
                  onClick={async () => { if (await act(x, 'set_time', { at: fromLocalInput(v), field })) setEdit((m) => { const n = { ...m }; delete n[k]; return n; }); }}>Save time</button>
              </div>
            );
          })}
        </details>
      )}
      {reviewStop && <FacilityReviewPrompt key={reviewStop.id} loadId={load.id} stop={reviewStop} onClose={() => setReviewStop(null)} />}
      {!reviewStop && isReviewableStop(last) && (
        <button type="button" data-testid="facility-review-open" onClick={() => setReviewStop(last)}
          style={{ ...btn, marginTop: 4, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px', fontWeight: 400, fontSize: '0.9rem' }}>Review this facility</button>
      )}
      <StopDelays supabase={supabase} load={load} />
      {err && <p role="alert" data-testid="stop-error" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
