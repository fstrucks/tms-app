'use client';
// Shared stops editor (add, remove, reorder, Pickup # on pickups). Used by /dispatch/<id> (edit a load) and
// /dispatch/boards (save a load from a board). State shape and validation live in app/lib/dispatch.js
// (stopsToForm / formToStops / blankStop / moveStop); saves go through public.dispatch_save_stops (2–20 stops,
// at least one pickup and one delivery).
import { blankStop, moveStop } from '../lib/dispatch';

export const STOP_STYLES = {
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.85rem', color: 'var(--text)' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 4, background: 'var(--surface)', color: 'var(--text)' },
  err: { color: 'var(--danger)', fontSize: '0.8rem', margin: '0.2rem 0 0' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  small: { minHeight: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 14, cursor: 'pointer' },
};
const s = STOP_STYLES;

export function Field({ label, value, onChange, error, type = 'text', inputMode, placeholder, required, textarea, disabled }) {
  const style = { ...s.input, ...(error ? { borderColor: 'var(--danger)' } : null), ...(textarea ? { minHeight: 96, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' } : null) };
  return (
    <label style={s.label}>
      {label}{required ? ' *' : ''}
      {textarea ? <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} aria-invalid={error ? 'true' : undefined} style={style} />
        : <input type={type} inputMode={inputMode} value={value} placeholder={placeholder} disabled={disabled} aria-invalid={error ? 'true' : undefined} onChange={(e) => onChange(e.target.value)} style={style} />}
      {error && <p style={s.err}>{error}</p>}
    </label>
  );
}

// stops: form rows from stopsToForm/blankStop; setStops: React state setter; stopErrors: formToStops().errors.
export default function StopsEditor({ stops, setStops, stopErrors = {}, browserTz = '', onEdit, disabled = false, testId = 'dispatch-stops' }) {
  const setStop = (key, k) => (v) => { setStops((l) => l.map((x) => (x.key === key ? { ...x, [k]: v } : x))); onEdit?.(); };
  return (
    <div style={s.card} data-testid={testId}>
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Stops</h2>
      {stopErrors._list && <p role="alert" style={s.err}>{stopErrors._list}</p>}
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {stops.map((x, i) => {
          const e = stopErrors[x.key] || {};
          return (
            <fieldset key={x.key} data-testid="dispatch-stop" style={{ border: '1px solid var(--divider)', borderRadius: 10, padding: '0.6rem 0.7rem', margin: '0 0 0.6rem' }}>
              <legend style={{ fontWeight: 600, padding: '0 4px' }}>Stop {i + 1}</legend>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                <select aria-label={`Stop ${i + 1} type`} value={x.stop_type} onChange={(ev) => setStop(x.key, 'stop_type')(ev.target.value)} style={{ ...s.small, minHeight: 36 }}>
                  <option value="pickup">Pickup</option><option value="delivery">Delivery</option>
                </select>
                <button type="button" data-compact onClick={() => setStops((l) => moveStop(l, i, -1))} disabled={i === 0} style={s.small} aria-label={`Move stop ${i + 1} up`}>↑</button>
                <button type="button" data-compact onClick={() => setStops((l) => moveStop(l, i, 1))} disabled={i === stops.length - 1} style={s.small} aria-label={`Move stop ${i + 1} down`}>↓</button>
                <button type="button" data-compact onClick={() => setStops((l) => l.filter((y) => y.key !== x.key))} disabled={stops.length <= 2} style={{ ...s.small, color: 'var(--danger)', borderColor: 'var(--danger-border)' }}>Remove</button>
              </div>
              <div className="dispatch-stop-grid">
                <Field label="Company" value={x.company_name} onChange={setStop(x.key, 'company_name')} />
                <Field label="Street address" value={x.address_line1} onChange={setStop(x.key, 'address_line1')} />
                <Field label="City" required value={x.city} onChange={setStop(x.key, 'city')} error={e.city} />
                <Field label="State" placeholder="CA" value={x.state} onChange={setStop(x.key, 'state')} error={e.state} />
                <Field label="ZIP" inputMode="numeric" value={x.zip} onChange={setStop(x.key, 'zip')} error={e.zip} />
                <Field label="Appointment from" type="datetime-local" value={x.appointment_start} onChange={setStop(x.key, 'appointment_start')} error={e.appointment_start} />
                <Field label="Appointment to" type="datetime-local" value={x.appointment_end} onChange={setStop(x.key, 'appointment_end')} error={e.appointment_end} />
                {x.stop_type === 'pickup' && <Field label="Pickup #" value={x.pickup_number} onChange={setStop(x.key, 'pickup_number')} error={e.pickup_number} />}
              </div>
              <p style={{ ...s.muted, margin: '0.3rem 0 0' }}>Times are in {x.timezone || browserTz || 'your time zone'}.</p>
              <div style={{ marginTop: '0.4rem' }}><Field label="Stop notes" value={x.notes} onChange={setStop(x.key, 'notes')} /></div>
            </fieldset>
          );
        })}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setStops((l) => [...l, blankStop('pickup', browserTz || '')])} style={{ ...s.small, minHeight: 44 }}>+ Add pickup</button>
          <button type="button" onClick={() => setStops((l) => [...l, blankStop('delivery', browserTz || '')])} style={{ ...s.small, minHeight: 44 }}>+ Add delivery</button>
        </div>
      </fieldset>
    </div>
  );
}
