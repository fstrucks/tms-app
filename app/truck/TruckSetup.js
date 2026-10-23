'use client';
// Maintenance setup for one truck, phone-first: 1) engine + how it's used + miles, 2) what's been done, 3) save.
// Done items with a date become one "before using the app" record (owner only, no expense). The rest start as due
// or unknown. Schedules come from the engine maker's suggested intervals, or general estimates when the engine is unknown.
import { useState } from 'react';
import { DUTY_CYCLES, NOT_SURE, engineKey, engineLabel, intervalText } from '../lib/pmSchedule';
import { laToday } from '../lib/sendCap';

export default function TruckSetup({ truck, engines, canBaseline, api, s, onDone, onCancel }) {
  const [step, setStep] = useState(1);
  const [v, setV] = useState({
    engine: truck.engine_model ? `${truck.engine_make}|${truck.engine_model}` : '', engineYear: truck.engine_year ?? '',
    dutyCycle: truck.duty_cycle || '', mpg: truck.mpg ?? '', odometer: truck.odometer ?? '',
  });
  const [vin, setVin] = useState(truck.vin || '');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setV((o) => ({ ...o, [k]: e.target.value }));
  const today = laToday();
  const post = (body) => api('/api/truck/schedules', { method: 'POST', body: JSON.stringify({ truckId: truck.id, ...body }) });

  async function lookUpVin() {
    setBusy(true); setMsg(null);
    const j = await post({ action: 'decode_vin', vin });
    setBusy(false);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    const d = j.decoded;
    setV((o) => ({ ...o, engine: d.engine || o.engine, engineYear: d.year || o.engineYear }));
    setMsg({ type: 'info', text: `VIN says: ${[d.year, d.make, d.model].filter(Boolean).join(' ')}${d.engineModel ? `, engine ${d.engineMake || ''} ${d.engineModel}` : ''}. ${d.engine ? 'We picked the engine below. Check it.' : 'Pick the engine below.'}` });
  }
  async function next(e) {
    e.preventDefault();
    if (!v.engine) return setMsg({ type: 'error', text: 'Pick the engine, or “Not sure”.' });
    if (!v.dutyCycle) return setMsg({ type: 'error', text: 'Pick how the truck is used.' });
    setBusy(true); setMsg(null);
    const j = await post({ action: 'preview', values: v });
    setBusy(false);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    setItems(j.items.map((x) => ({ ...x, done: false, date: today, dateUnknown: false, miles: String(v.odometer ?? ''), milesUnknown: !String(v.odometer ?? '') })));
    setStep(2);
  }
  const upd = (k, patch) => setItems((xs) => xs.map((x) => (x.serviceType === k ? { ...x, ...patch } : x)));
  async function save() {
    setBusy(true); setMsg(null);
    const j = await post({ action: 'setup', values: { ...v, items: items.map(({ serviceType, done, date, dateUnknown, miles, milesUnknown }) => ({ serviceType, done, date, dateUnknown, miles, milesUnknown })) } });
    setBusy(false);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    onDone?.(j);
  }

  const box = { ...s.input, width: '100%', minHeight: 44, fontSize: 16 };
  const radio = (on) => ({ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: `1px solid ${on ? 'var(--primary)' : 'var(--divider)'}`, borderRadius: 10, marginBottom: 6, fontSize: 16, cursor: 'pointer' });
  return (
    <div data-testid="truck-setup-flow">
      <p style={{ ...s.muted, margin: '0 0 8px' }}>Step {step} of 2</p>
      {msg && <p role={msg.type === 'error' ? 'alert' : 'status'} style={msg.type === 'error' ? s.err : { ...s.muted, color: 'var(--primary)' }}>{msg.text}</p>}
      {step === 1 ? (
        <form onSubmit={next}>
          <label style={s.label} htmlFor="setup-vin">VIN (optional, fills in what it can)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="setup-vin" style={box} value={vin} maxLength={17} autoCapitalize="characters" onChange={(e) => setVin(e.target.value.toUpperCase())} />
            <button type="button" style={{ ...s.btn2, width: 'auto', marginTop: 0, padding: '0 14px' }} disabled={busy || vin.trim().length !== 17} onClick={lookUpVin}>Look up</button>
          </div>
          <label style={s.label} htmlFor="setup-engine">Engine</label>
          <select id="setup-engine" data-testid="setup-engine" style={box} value={v.engine} onChange={set('engine')}>
            <option value="">Choose…</option>
            {engines.map((e) => <option key={engineKey(e)} value={engineKey(e)}>{engineLabel(e.maker, e.model)}</option>)}
            <option value={NOT_SURE}>Not sure / not listed</option>
          </select>
          <label style={s.label} htmlFor="setup-year">Engine year (optional)</label>
          <input id="setup-year" style={box} inputMode="numeric" maxLength={4} value={v.engineYear} onChange={set('engineYear')} />
          <fieldset style={{ border: 'none', padding: 0, margin: '10px 0 0' }}>
            <legend style={s.label}>How is the truck used?</legend>
            {DUTY_CYCLES.map(([k, label, hint]) => (
              <label key={k} style={radio(v.dutyCycle === k)}>
                <input type="radio" name="duty" value={k} checked={v.dutyCycle === k} onChange={set('dutyCycle')} style={{ width: 20, height: 20, marginTop: 2 }} />
                <span><strong>{label}</strong><br /><span style={s.muted}>{hint}</span></span>
              </label>
            ))}
          </fieldset>
          <label style={s.label} htmlFor="setup-mpg">Average MPG (optional; some fuel filter intervals depend on it)</label>
          <input id="setup-mpg" style={box} inputMode="decimal" value={v.mpg} onChange={set('mpg')} />
          <label style={s.label} htmlFor="setup-odo">Odometer now</label>
          <input id="setup-odo" data-testid="setup-odometer" style={box} inputMode="numeric" value={v.odometer} onChange={set('odometer')} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="submit" style={s.btn} disabled={busy}>{busy ? 'Working…' : 'Next'}</button>
            {onCancel && <button type="button" style={s.btn2} onClick={onCancel}>Later</button>}
          </div>
        </form>
      ) : (
        <div>
          <p style={{ margin: '0 0 8px', fontSize: 15 }}>{canBaseline ? 'Check what’s been done and roughly when. Leave unchecked if it hasn’t been done or you don’t know.' : 'Recommended services for this truck. Check anything already done; the owner can add dates later.'}</p>
          {items.map((x) => (
            <div key={x.serviceType} style={{ borderTop: '1px solid var(--divider)', padding: '6px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 16 }}>
                <input type="checkbox" data-testid={`setup-done-${x.serviceType}`} style={{ width: 22, height: 22 }} checked={x.done} onChange={(e) => upd(x.serviceType, { done: e.target.checked })} />
                <span><strong>{x.label}</strong><br /><span style={{ ...s.muted, fontSize: 13 }}>{intervalText({ interval_miles: x.intervalMiles, interval_days: x.intervalDays })} · {x.sourceText}</span></span>
              </label>
              {x.done && !canBaseline && <p data-testid={`setup-owner-note-${x.serviceType}`} style={{ ...s.muted, fontSize: 13, margin: '0 0 0 32px' }}>Owner can confirm last service.</p>}
              {x.done && canBaseline && (
                <div style={{ paddingLeft: 32, display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="date" aria-label={`${x.label} date`} style={{ ...s.input, minHeight: 44 }} max={today} value={x.date} disabled={x.dateUnknown} onChange={(e) => upd(x.serviceType, { date: e.target.value })} />
                    <label style={{ fontSize: 14 }}><input type="checkbox" checked={x.dateUnknown} onChange={(e) => upd(x.serviceType, { dateUnknown: e.target.checked })} /> Not sure when</label>
                  </div>
                  {!x.dateUnknown && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input aria-label={`${x.label} miles`} placeholder="Miles" inputMode="numeric" style={{ ...s.input, minHeight: 44, maxWidth: 160 }} value={x.miles} disabled={x.milesUnknown} onChange={(e) => upd(x.serviceType, { miles: e.target.value })} />
                      <label style={{ fontSize: 14 }}><input type="checkbox" checked={x.milesUnknown} onChange={(e) => upd(x.serviceType, { milesUnknown: e.target.checked })} /> Not sure of miles</label>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <p style={{ ...s.muted, fontSize: 12 }}>Intervals are starting points. You can change any of them after setup.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" data-testid="setup-save" style={s.btn} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save schedule'}</button>
            <button type="button" style={s.btn2} disabled={busy} onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
