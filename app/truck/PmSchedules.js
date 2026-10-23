'use client';
// Maintenance schedule on the Truck tab: "Finish truck setup" prompt, status badges, editable intervals and where
// each interval came from. Data: /api/truck/schedules. Hidden until the database update is applied.
import { useEffect, useRef, useState } from 'react';
import TruckSetup from './TruckSetup';
import { STATUS_LABEL, intervalText, dueText, engineLabel, badgeStyle } from '../lib/pmSchedule';

export default function PmSchedules({ truck, api, s, autoSetup = false, reloadKey = 0, onChanged, onSetupDone }) {
  const [d, setD] = useState(null);
  const [setup, setSetup] = useState(false);
  const [edits, setEdits] = useState({}); // per row: { [scheduleId]: { intervalMiles, intervalDays } }
  const setRowEdit = (id, patch) => setEdits((o) => (patch === null ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== id)) : { ...o, [id]: { ...o[id], ...patch } }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const seq = useRef(0);

  async function refresh() {
    const n = ++seq.current;
    const j = await api(`/api/truck/schedules?truckId=${truck.id}&_=${Date.now()}`);
    if (n === seq.current) setD(j.error ? { available: true, error: j.error, schedule: [] } : j);
  }
  useEffect(() => { setD(null); setSetup(autoSetup); setEdits({}); setMsg(null); refresh(); }, [truck.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoSetup) setSetup(true); }, [autoSetup]);
  useEffect(() => { if (reloadKey) refresh(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d || d.available === false) return null;

  async function saveEdit(e, id) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const j = await api('/api/truck/schedules', { method: 'POST', body: JSON.stringify({ action: 'save_schedule', truckId: truck.id, id, values: edits[id] }) });
    setBusy(false);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    setRowEdit(id, null); setMsg({ type: 'ok', text: 'Interval saved.' });
    await refresh(); onChanged?.();
  }
  const t = d.truck || {};
  return (
    <section style={s.card} aria-label="Maintenance schedule" data-testid="pm-card">
      <h2 style={s.h2}>Maintenance schedule</h2>
      {msg && <p role={msg.type === 'error' ? 'alert' : 'status'} style={msg.type === 'error' ? s.err : { color: 'var(--success)', fontSize: 14 }}>{msg.text}</p>}
      {d.error && <p role="alert" style={s.err}>{d.error}</p>}
      {setup ? (
        <TruckSetup truck={t} today={d.today} engines={d.engines || []} canBaseline={d.canBaseline} api={api} s={s}
          onCancel={() => setSetup(false)}
          onDone={async (j) => { setSetup(false); setMsg({ type: 'ok', text: `Setup saved: ${j.schedules} service${j.schedules === 1 ? '' : 's'} on the schedule.` });
            // Card, history and truck details all refetch now; each keeps only its newest response.
            onSetupDone?.(); onChanged?.(); await refresh(); }} />
      ) : (<>
        {d.needsSetup && (
          <div data-testid="finish-setup" style={{ border: '1px solid var(--warning)', background: 'var(--warning-bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
            <strong>Finish truck setup</strong>
            <p style={{ ...s.muted, margin: '4px 0 8px' }}>Tell us the engine, how the truck is used and what’s been done, and we’ll track when service is due.</p>
            {d.canEdit ? <button type="button" style={s.btn} onClick={() => setSetup(true)}>Finish setup</button> : <p style={s.muted}>The owner or management can do this.</p>}
          </div>
        )}
        {!d.needsSetup && (
          <p style={{ ...s.muted, margin: '0 0 8px' }}>
            Engine: {engineLabel(t.engine_make, t.engine_model)}{t.duty_cycle && t.duty_cycle !== 'unknown' ? ` · ${t.duty_cycle.replace('_', ' ')}` : ''}
            {d.canEdit && <> · <button type="button" style={{ ...s.small, minHeight: 32 }} onClick={() => setSetup(true)}>Redo setup</button></>}
          </p>
        )}
        {(d.schedule || []).map((r) => (
          <div key={r.schedule_id} data-testid={`pm-row-${r.service_type}`} style={{ borderTop: '1px solid var(--divider)', padding: '8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 16 }}>{r.label}</strong>
              <span data-testid={`pm-badge-${r.service_type}`} style={{ ...badgeStyle(r.status), marginLeft: 'auto' }}>{STATUS_LABEL[r.status] || r.status}</span>
            </div>
            <div style={{ ...s.muted, fontSize: 13 }}>{dueText(r)}</div>
            {edits[r.schedule_id] ? (
              <form onSubmit={(e) => saveEdit(e, r.schedule_id)} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                <input aria-label="Every how many miles" placeholder="Miles" inputMode="numeric" style={{ ...s.input, maxWidth: 120, minHeight: 44 }} value={edits[r.schedule_id].intervalMiles} onChange={(e) => setRowEdit(r.schedule_id, { intervalMiles: e.target.value })} />
                <input aria-label="Every how many days" placeholder="Days" inputMode="numeric" style={{ ...s.input, maxWidth: 100, minHeight: 44 }} value={edits[r.schedule_id].intervalDays} onChange={(e) => setRowEdit(r.schedule_id, { intervalDays: e.target.value })} />
                <button type="submit" style={s.btn} disabled={busy}>Save</button>
                <button type="button" style={s.btn2} onClick={() => setRowEdit(r.schedule_id, null)}>Cancel</button>
              </form>
            ) : (
              <div style={{ fontSize: 13, marginTop: 2 }}>
                {intervalText(r)}{' '}
                {d.canEdit && <button type="button" style={{ ...s.small, minHeight: 32 }} onClick={() => setRowEdit(r.schedule_id, { intervalMiles: String(r.interval_miles ?? ''), intervalDays: String(r.interval_days ?? '') })}>Edit</button>}
                <div style={{ ...s.muted, fontSize: 12 }}>{r.sourceText}</div>
              </div>
            )}
          </div>
        ))}
      </>)}
    </section>
  );
}
