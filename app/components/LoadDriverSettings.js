'use client';

// Load page: assigned driver + "Show rate to driver" (Marc, Oct 18 2026). Saved through
// public.set_load_driver_settings() (owner, management, dispatcher; the database checks the role and that the
// person is a driver on the company). Rendered only when the load row has show_rate_to_driver, i.e. after
// migration 20261018000600 is applied.
import { useEffect, useState } from 'react';
import { fetchDriverChoices, saveDriverSettings, driverLabel } from '../lib/loadDriver';

const st = {
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 4, background: 'var(--surface)', color: 'var(--text)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
};

export default function LoadDriverSettings({ supabase, load, cardStyle, onSaved }) {
  const [choices, setChoices] = useState([]);
  const [driver, setDriver] = useState(load.assigned_driver_user_id || '');
  const [show, setShow] = useState(load.show_rate_to_driver === true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { setDriver(load.assigned_driver_user_id || ''); setShow(load.show_rate_to_driver === true); }, [load.id, load.assigned_driver_user_id, load.show_rate_to_driver]);
  useEffect(() => {
    let live = true;
    fetchDriverChoices(supabase).then((r) => { if (!live) return; if (r.error) console.error('[load] drivers', r.error); setChoices(r.choices || []); });
    return () => { live = false; };
  }, [load.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = (driver || null) !== (load.assigned_driver_user_id || null) || show !== (load.show_rate_to_driver === true);
  // The current driver may no longer be in the list (removed from the company): keep showing him.
  const list = driver && !choices.some((c) => c.user_id === driver) ? [...choices, { user_id: driver, email: 'Current driver (no longer on the company)' }] : choices;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await saveDriverSettings(supabase, load.id, { driverId: driver || null, showRate: show });
      if (!r.ok) { console.error('[load] driver settings', r.cause); return setMsg({ err: true, text: r.error }); }
      onSaved?.({ assigned_driver_user_id: r.row?.assigned_driver_user_id ?? null, show_rate_to_driver: r.row?.show_rate_to_driver === true });
      setMsg({ err: false, text: 'Saved.' });
    } finally { setSaving(false); }
  }

  return (
    <div style={cardStyle} data-testid="load-driver-settings">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Driver</h2>
      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text)' }}>Assigned driver
        <select value={driver} onChange={(e) => { setDriver(e.target.value); setMsg(null); }} style={st.input}>
          <option value="">Not assigned</option>
          {list.map((c) => <option key={c.user_id} value={c.user_id}>{driverLabel(c)}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={show} onChange={(e) => { setShow(e.target.checked); setMsg(null); }} style={{ width: 22, height: 22 }} />
        <span>Show rate to driver</span>
      </label>
      <p style={{ ...st.muted, margin: '0 0 0.5rem' }}>Off: the assigned driver never sees the rate or rate per mile for this load.</p>
      <button type="button" disabled={!dirty || saving} onClick={save}
        style={{ minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: dirty ? 'var(--primary)' : 'var(--primary-soft)', color: 'var(--on-primary)', fontWeight: 600 }}>
        {saving ? 'Saving…' : 'Save driver settings'}
      </button>
      {msg && <p role={msg.err ? 'alert' : 'status'} style={{ color: msg.err ? 'var(--danger)' : 'var(--success)', fontSize: '0.9rem', margin: '0.5rem 0 0' }}>{msg.text}</p>}
    </div>
  );
}
