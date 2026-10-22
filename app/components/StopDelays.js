'use client';
// Delays at a stop (waiting to load, breakdown, …): add, edit, delete. Under the stop check-off on the Home card and
// the load page. Hidden before the stop_delays migration (the API answers setupNeeded). Server enforces access.
import { useCallback, useEffect, useState } from 'react';
import { sortedStops } from '../lib/loadTabs';
import { toLocalInput, fromLocalInput, fmtDuration } from '../lib/stopProgress';
import { DELAY_REASONS, delayReasonLabel, delaysForStop, delayMinutes } from '../lib/stopDelays';

async function call(supabase, loadId, method, body) {
  try {
    const { data: s } = await supabase.auth.getSession();
    const r = await fetch(`/api/loads/${loadId}/delays`, { method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.session?.access_token || ''}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { ...j, error: j.error || 'That didn’t save. Please try again.' };
  } catch { return { error: 'Couldn’t reach the server. Check your connection and try again.' }; }
}
const blank = (stopId) => ({ id: null, stop_id: stopId, reason: '', note: '', started_at: toLocalInput(new Date().toISOString()), ended_at: '' });
const fmtT = (iso) => new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function StopDelays({ supabase, load }) {
  const [delays, setDelays] = useState(null); // null = loading / hidden
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const refresh = useCallback(async () => {
    if (!supabase || !load?.id) return;
    const j = await call(supabase, load.id, 'GET');
    setDelays(j.setupNeeded || j.error ? null : j.delays || []);
  }, [supabase, load?.id]);
  useEffect(() => { refresh(); }, [refresh]);
  if (delays == null) return null;
  const st = sortedStops(load);
  const input = { minHeight: 40, fontSize: 16, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };
  const btn = { minHeight: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.9rem', cursor: 'pointer' };
  const link = { ...btn, border: 'none', background: 'none', color: 'var(--primary)', padding: '0 6px' };

  async function save() {
    setErr(null); setBusy(true);
    const payload = { reason: form.reason, note: form.note, started_at: fromLocalInput(form.started_at), ended_at: form.ended_at ? fromLocalInput(form.ended_at) : '' };
    const j = form.id ? await call(supabase, load.id, 'PATCH', { id: form.id, ...payload }) : await call(supabase, load.id, 'POST', { stop_id: form.stop_id, ...payload });
    setBusy(false);
    if (j.error) return setErr(j.error);
    setForm(null); refresh();
  }
  async function remove(d) {
    setErr(null); setBusy(true);
    const j = await call(supabase, load.id, 'DELETE', { id: d.id });
    setBusy(false);
    if (j.error) return setErr(j.error);
    if (form?.id === d.id) setForm(null);
    refresh();
  }
  return (
    <details data-testid="stop-delays" style={{ marginTop: 8 }} open={delays.length > 0 || !!form}>
      <summary style={{ cursor: 'pointer', minHeight: 32, color: 'var(--primary)', fontSize: '0.9rem' }}>Delays{delays.length ? ` (${delays.length})` : ''}</summary>
      {st.map((x, i) => (
        <div key={x.id} style={{ marginTop: 6 }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Stop {i + 1}{x.company_name ? ` · ${x.company_name}` : ''}</div>
          {delaysForStop(delays, x.id).map((d) => (
            <div key={d.id} data-testid="stop-delay" style={{ fontSize: '0.85rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
              <span>{delayReasonLabel(d.reason)} · {fmtT(d.started_at)} – {d.ended_at ? fmtT(d.ended_at) : 'ongoing'}{delayMinutes(d) != null ? ` (${fmtDuration(delayMinutes(d))})` : ''}{d.note ? ` · ${d.note}` : ''}</span>
              <button type="button" style={link} disabled={busy} onClick={() => { setErr(null); setForm({ id: d.id, stop_id: d.stop_id, reason: d.reason, note: d.note || '', started_at: toLocalInput(d.started_at), ended_at: d.ended_at ? toLocalInput(d.ended_at) : '' }); }}>Edit</button>
              <button type="button" data-testid="stop-delay-delete" style={{ ...link, color: 'var(--danger)' }} disabled={busy} onClick={() => remove(d)}>Delete</button>
            </div>
          ))}
          {form?.stop_id === x.id ? (
            <div role="group" data-testid="stop-delay-form" aria-label={form.id ? 'Edit delay' : 'Log a delay'} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <select aria-label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} style={input}>
                <option value="" disabled>Reason…</option>
                {DELAY_REASONS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
              </select>
              <input aria-label={form.reason === 'other' ? 'Note (required)' : 'Note (optional)'} placeholder={form.reason === 'other' ? 'What happened? (required)' : 'Note (optional)'} value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ ...input, flex: '1 1 180px' }} />
              <label style={{ fontSize: '0.85rem' }}>Start <input type="datetime-local" aria-label="Delay start" value={form.started_at} onChange={(e) => setForm({ ...form, started_at: e.target.value })} style={input} /></label>
              <label style={{ fontSize: '0.85rem' }}>End <input type="datetime-local" aria-label="Delay end (optional)" value={form.ended_at} onChange={(e) => setForm({ ...form, ended_at: e.target.value })} style={input} /></label>
              {!form.ended_at && <button type="button" style={link} onClick={() => setForm({ ...form, ended_at: toLocalInput(new Date().toISOString()) })}>End now</button>}
              <button type="button" data-testid="stop-delay-save" disabled={busy} onClick={save} style={{ ...btn, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600 }}>{busy ? 'Saving…' : 'Save delay'}</button>
              <button type="button" style={btn} disabled={busy} onClick={() => setForm(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" data-testid="stop-delay-add" style={link} disabled={busy} onClick={() => { setErr(null); setForm(blank(x.id)); }}>+ Log a delay</button>
          )}
        </div>
      ))}
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </details>
  );
}
