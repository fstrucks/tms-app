'use client';
// Per-stop check-off (PR #115) for the Home current-load card and the load page: "Picked up" / "Delivered" / "Done"
// for the next stop, "Skip to next stop", and Undo for the last one marked. Confirm-on-tap. Hidden before the
// stops.completed_at migration, for viewers who can't act, and on loads without stops. Server enforces roles.
import { useState } from 'react';
import { nextStopIndex, STOP_LABEL } from '../lib/homeCurrentLoad';
import { sortedStops } from '../lib/loadTabs';
import { supportsStopCompletion, canCompleteStops, stopActionLabel, lastCompletedStop, allStopsDone, isStopDone } from '../lib/stopProgress';

async function post(supabase, loadId, stopId, action) {
  try {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch(`/api/loads/${loadId}/stops/${stopId}`, { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.session?.access_token || ''}` }, body: JSON.stringify({ action }) });
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

export default function StopActions({ supabase, load, userId, role, onChange, onRefresh, now }) {
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // one confirm at a time: 'done' | 'skip' | null
  if (hidden || !load || !supportsStopCompletion(load) || !canCompleteStops(role ?? load.viewer_role ?? 'owner', load, userId)) return null;
  const st = sortedStops(load);
  const done = allStopsDone(load);
  const target = done ? null : st[nextStopIndex(load, now)];
  const last = lastCompletedStop(load);
  const open = st.filter((x) => !isStopDone(x));
  const isLast = target && open.length === 1;
  const n = target ? st.indexOf(target) + 1 : 0;

  async function act(stop, action) {
    setErr(null); setBusy(true);
    const r = await post(supabase, load.id, stop.id, action);
    setBusy(false); setPending(null);
    if (r.setupNeeded) { setHidden(true); return false; }
    if (!r.ok) { setErr(r.error); return false; }
    onChange?.(applyStopResult(load, r)); // the re-read server row (also for "already done": treated as success)
    try { onRefresh?.(); } catch (e) { console.error('[stops] refresh', e); } // then re-read the whole load
    return true;
  }
  const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer' };
  const pri = { ...btn, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' };
  const sec = { ...btn, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' };
  const label = target ? stopActionLabel(target) : '';
  const question = pending === 'skip' ? `Skip stop ${n} and go to the next stop?` : `Mark stop ${n} ${label.toLowerCase()}?`;
  return (
    <div data-testid="stop-actions" style={{ borderTop: '1px solid var(--divider)', marginTop: 12, paddingTop: 10 }}>
      {target ? (
        <>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 6 }}>
            Stop {n} of {st.length} · {STOP_LABEL(target)}{target.company_name ? ` · ${target.company_name}` : ''}
          </div>
          {pending ? (
            <div role="group" data-testid="stop-confirm" aria-label={question} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span style={{ flexBasis: '100%', fontWeight: 600, color: 'var(--text)' }}>{question}</span>
              <button type="button" data-testid="stop-confirm-yes" disabled={busy} style={pri} onClick={() => act(target, pending)}>
                {busy ? 'Saving…' : pending === 'skip' ? 'Yes, skip' : `Yes, ${label.toLowerCase()}`}</button>
              <button type="button" data-testid="stop-confirm-cancel" disabled={busy} style={sec} onClick={() => setPending(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" data-testid="stop-mark" disabled={busy} style={pri} onClick={() => { setErr(null); setPending('done'); }}>{label}</button>
              {!isLast && <button type="button" data-testid="stop-skip" disabled={busy} style={sec} onClick={() => { setErr(null); setPending('skip'); }}>Skip to next stop</button>}
            </div>
          )}
        </>
      ) : <div style={{ fontSize: '0.9rem', color: 'var(--success)', fontWeight: 600 }}>All stops done.</div>}
      {last && !pending && (
        <button type="button" data-testid="stop-undo" disabled={busy} onClick={() => act(last, 'undo')}
          style={{ ...btn, marginTop: 8, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>
          Undo {last.completion === 'skipped' ? 'skip' : `“${stopActionLabel(last)}”`} (stop {st.indexOf(last) + 1})
        </button>
      )}
      {err && <p role="alert" data-testid="stop-error" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
