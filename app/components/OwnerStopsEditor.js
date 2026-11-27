'use client';
// Owner's load page: "+ Add stop" opens the shared StopsEditor with a new delivery already placed before the final
// delivery. The owner can add pickups / deliveries, reorder (↑/↓), remove (not checked-off stops) and save.
// Saves through public.dispatch_save_stops (see lib/ownerStops). Hidden for drivers and other team viewers.
import { useState } from 'react';
import StopsEditor, { STOP_STYLES } from './StopsEditor';
import { canOwnerEditStops, openWithNewStop, saveOwnerStops, MAX_STOPS } from '../lib/ownerStops';
import { stopsToForm } from '../lib/dispatch';
import { notifyLoadChanged } from '../lib/loadSync';

const btn = { minHeight: 44, padding: '0 16px', borderRadius: 8, fontSize: 16, fontWeight: 600 };
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

export default function OwnerStopsEditor({ supabase, load, onSaved }) {
  const [stops, setStops] = useState(null); // null = closed; else form rows
  const [errors, setErrors] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!canOwnerEditStops(load)) return null;
  const tz = zone();
  const count = load.stops.length;

  if (!stops) {
    return (
      <div style={{ marginTop: '0.5rem' }}>
        {msg?.ok && <p role="status" data-testid="owner-stops-saved" style={{ color: 'var(--success)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>{msg.text}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" data-testid="owner-add-stop" disabled={count >= MAX_STOPS}
            onClick={() => { setMsg(null); setErrors({}); setStops(openWithNewStop(load.stops, 'delivery', tz)); }}
            style={{ ...btn, border: '1px solid var(--primary)', background: 'var(--surface)', color: 'var(--primary)' }}>+ Add stop</button>
          {count > 0 && (
            <button type="button" data-testid="owner-edit-stops" onClick={() => { setMsg(null); setErrors({}); setStops(stopsToForm(load.stops)); }}
              style={{ ...btn, fontWeight: 400, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>Edit stops</button>
          )}
        </div>
        {count >= MAX_STOPS && <p style={{ ...STOP_STYLES.muted, margin: '0.4rem 0 0' }}>A load can have up to {MAX_STOPS} stops.</p>}
      </div>
    );
  }

  async function save() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await saveOwnerStops(supabase, load.id, load.stops, stops, { browserTz: tz || null });
      if (!r.ok) { setErrors(r.errors || {}); if (r.error) setMsg({ ok: false, text: r.error }); return; }
      setErrors({}); setStops(null);
      setMsg({ ok: true, text: 'Stops saved.' });
      notifyLoadChanged(load.id); // Home card / other tabs re-read the load
      onSaved?.(r.stops);
    } finally { setBusy(false); }
  }
  const newKeys = new Set(stops.filter((x) => x.id == null).map((x) => x.key));
  return (
    <div style={{ marginTop: '0.75rem' }} data-testid="owner-stops-editor">
      <StopsEditor stops={stops} setStops={setStops} stopErrors={errors} browserTz={tz} onEdit={() => setMsg(null)} disabled={busy}
        testId="owner-stops" title="Edit stops" lockDone addBeforeLastDelivery flat newKeys={newKeys} />
      {msg && !msg.ok && <p role="alert" data-testid="owner-stops-error" style={{ ...STOP_STYLES.err, fontSize: '0.9rem', margin: '0 0 0.5rem' }}>{msg.text}</p>}
      {Object.keys(errors).some((k) => k !== '_list') && <p role="alert" style={{ ...STOP_STYLES.err, fontSize: '0.9rem', margin: '0 0 0.5rem' }}>Check the highlighted fields.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" data-testid="owner-stops-save" onClick={save} disabled={busy}
          style={{ ...btn, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' }}>{busy ? 'Saving…' : 'Save stops'}</button>
        <button type="button" data-testid="owner-stops-cancel" onClick={() => { setStops(null); setErrors({}); setMsg(null); }} disabled={busy}
          style={{ ...btn, fontWeight: 400, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>Cancel</button>
      </div>
    </div>
  );
}
