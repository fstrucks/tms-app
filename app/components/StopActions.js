'use client';
// Per-stop check-off (PR #115) for the Home current-load card and the load page: "Picked up" / "Delivered" / "Done"
// for the next stop, "Skip to next stop", and Undo for the last one marked. Confirm-on-tap. Hidden before the
// stops.completed_at migration, for viewers who can't act, and on loads without stops. Server enforces roles.
import { useState } from 'react';
import ConfirmButton from './ui/ConfirmButton';
import { nextStopIndex, STOP_LABEL } from '../lib/homeCurrentLoad';
import { sortedStops } from '../lib/loadTabs';
import { supportsStopCompletion, canCompleteStops, stopActionLabel, lastCompletedStop, allStopsDone, isStopDone } from '../lib/stopProgress';

async function post(supabase, loadId, stopId, action) {
  const { data: s } = await supabase.auth.getSession();
  const res = await fetch(`/api/loads/${loadId}/stops/${stopId}`, { method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.session?.access_token || ''}` }, body: JSON.stringify({ action }) });
  const j = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, ...j } : { ok: false, status: res.status, ...j };
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
  if (hidden || !load || !supportsStopCompletion(load) || !canCompleteStops(role ?? load.viewer_role ?? 'owner', load, userId)) return null;
  const st = sortedStops(load);
  const done = allStopsDone(load);
  const next = done ? null : st[nextStopIndex(load, now)];
  const target = next && !isStopDone(next) ? next : st.find((x) => !isStopDone(x));
  const last = lastCompletedStop(load);
  const isLast = target && st.filter((x) => !isStopDone(x)).length === 1;

  async function act(stop, action) {
    setErr(null); setBusy(true);
    const r = await post(supabase, load.id, stop.id, action);
    setBusy(false);
    if (r.setupNeeded) { setHidden(true); return false; }
    if (!r.ok) { setErr(r.error || 'Couldn’t save. Try again.'); return false; }
    onChange?.(applyStopResult(load, r)); // server row (also for "already done": treated as success)
    try { onRefresh?.(); } catch (e) { console.error('[stops] refresh', e); } // then re-read the load from the server
    return true;
  }
  const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer' };
  return (
    <div data-testid="stop-actions" style={{ borderTop: '1px solid var(--divider)', marginTop: 12, paddingTop: 10 }}>
      {target ? (
        <>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 6 }}>
            Stop {st.indexOf(target) + 1} of {st.length} · {STOP_LABEL(target)}{target.company_name ? ` · ${target.company_name}` : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <ConfirmButton danger={false} label={stopActionLabel(target)} confirmLabel={`Yes, ${stopActionLabel(target).toLowerCase()}`}
              ariaLabel={`Mark stop ${st.indexOf(target) + 1} ${stopActionLabel(target).toLowerCase()}?`} disabled={busy} onConfirm={() => act(target, 'done')} />
            {!isLast && <ConfirmButton danger={false} label="Skip to next stop" confirmLabel="Skip"
              ariaLabel={`Skip stop ${st.indexOf(target) + 1}?`} disabled={busy} onConfirm={() => act(target, 'skip')} />}
          </div>
        </>
      ) : <div style={{ fontSize: '0.9rem', color: 'var(--success)', fontWeight: 600 }}>All stops done.</div>}
      {last && (
        <button type="button" data-testid="stop-undo" disabled={busy} onClick={() => act(last, 'undo')}
          style={{ ...btn, marginTop: 8, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 4px' }}>
          Undo {last.completion === 'skipped' ? 'skip' : `“${stopActionLabel(last)}”`} (stop {st.indexOf(last) + 1})
        </button>
      )}
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
