'use client';

// /dispatch/<id>: management and dispatchers edit one of the owner's loads: every load field (notes included),
// the assigned driver, "Show rate to driver", and the stops (add, remove, reorder). Saves go through
// public.dispatch_update_load / public.dispatch_save_stops (SECURITY DEFINER, role-checked in the database).
// Drivers never get here with data: dispatch_loads() returns nothing to them.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import SignInLink from '../../components/SignInLink';
import { Loading, LoadError } from '../../components/DataState';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import { StatusBadge, fmtMoney } from '../../lib/loads';
import { isLoadId } from '../../lib/loadNew';
import { fetchDriverChoices, driverLabel, driverRateHelp, driverOptions } from '../../lib/loadDriver';
import {
  STATUSES, SETUP_MSG, fetchDispatchContext, fetchDispatchLoads, loadToForm, formToPatch, stopsToForm, formToStops, blankStop, moveStop,
  saveLoad, saveStops, rateConUrl, notesMayShowPay,
} from '../../lib/dispatch';

const s = {
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 820, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.85rem', color: '#374151' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid #d1d5db', marginTop: 4, background: '#fff', color: '#111827' },
  err: { color: '#b91c1c', fontSize: '0.8rem', margin: '0.2rem 0 0' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  link: { color: '#2563eb' },
  small: { minHeight: 36, padding: '0 10px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, cursor: 'pointer' },
  pri: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: 16, cursor: 'pointer' },
};

function Field({ label, value, onChange, error, type = 'text', inputMode, placeholder, required, textarea }) {
  const style = { ...s.input, ...(error ? { borderColor: '#b91c1c' } : null), ...(textarea ? { minHeight: 96, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' } : null) };
  return (
    <label style={s.label}>
      {label}{required ? ' *' : ''}
      {textarea ? <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-invalid={error ? 'true' : undefined} style={style} />
        : <input type={type} inputMode={inputMode} value={value} placeholder={placeholder} aria-invalid={error ? 'true' : undefined} onChange={(e) => onChange(e.target.value)} style={style} />}
      {error && <p style={s.err}>{error}</p>}
    </label>
  );
}

export default function DispatchLoadPage() {
  const { id } = useParams();
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState({ status: 'loading' });
  const [form, setForm] = useState(null);
  const [stops, setStops] = useState([]);
  const [errors, setErrors] = useState({});
  const [stopErrors, setStopErrors] = useState({});
  const [drivers, setDrivers] = useState([]);
  const [driversLoaded, setDriversLoaded] = useState(false); // until true the picker shows Loading (no false "no longer on the company")
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [rcBusy, setRcBusy] = useState(false);
  const browserTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } }, []);

  function apply(load) {
    setState({ status: 'ready', load });
    setForm(loadToForm(load));
    setStops(stopsToForm(load.stops || []));
    setErrors({}); setStopErrors({});
  }

  async function fetchLoad() {
    setState({ status: 'loading' }); setMsg(null);
    if (!isLoadId(id)) return setState({ status: 'missing' });
    if (!(await hasSession(supabase))) return setState({ status: 'error', text: 'Your session has expired or is still loading. Tap Retry, or sign in again.' });
    const ctx = await fetchDispatchContext(supabase);
    if (ctx.setup) return setState({ status: 'setup' });
    if (ctx.error) { console.error('[dispatch] context', ctx.error); return setState({ status: 'error', text: 'Couldn’t load this load.' }); }
    if (!ctx.companies.length) return setState({ status: 'not-member' });
    const res = await fetchDispatchLoads(supabase, id);
    if (res.setup) return setState({ status: 'setup' });
    if (res.error) { console.error('[dispatch] load', res.error); return setState({ status: 'error', text: 'Couldn’t load this load.' }); }
    const load = res.loads[0];
    if (!load) return setState({ status: 'missing' });
    setDriversLoaded(false);
    apply(load);
    const drv = await fetchDriverChoices(supabase, load.owner_id);
    if (drv.error) console.error('[dispatch] drivers', drv.error);
    setDrivers(drv.choices || []);
    setDriversLoaded(true);
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && u) setTimeout(() => fetchLoad(), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = state.load;
  const original = useMemo(() => (load ? JSON.stringify(formToStops(stopsToForm(load.stops || []), { browserTz }).payload) : null), [load, browserTz]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setMsg(null); };
  const setStop = (key, k) => (v) => { setStops((l) => l.map((x) => (x.key === key ? { ...x, [k]: v } : x))); setMsg(null); };

  async function save(e) {
    e.preventDefault();
    if (saving) return;
    setMsg(null);
    const p = formToPatch(form, load);
    const st = formToStops(stops, { browserTz });
    setErrors(p.errors || {}); setStopErrors(st.errors || {});
    if (!p.patch || !st.payload) return setMsg({ err: true, text: 'Please fix the highlighted fields.' });
    const stopsChanged = JSON.stringify(st.payload) !== original;
    if (!Object.keys(p.patch).length && !stopsChanged) return setMsg({ err: false, text: 'No changes to save.' });
    setSaving(true);
    try {
      if (!(await hasSession(supabase))) return setMsg({ err: true, text: 'Your session has expired. Please sign in again.' });
      if (Object.keys(p.patch).length) {
        const r = await saveLoad(supabase, id, p.patch);
        if (!r.ok) { console.error('[dispatch] save load', r.cause); return setMsg({ err: true, text: r.error }); }
      }
      if (stopsChanged) {
        const r = await saveStops(supabase, id, st.payload);
        if (!r.ok) { console.error('[dispatch] save stops', r.cause); return setMsg({ err: true, text: `${r.error}${Object.keys(p.patch).length ? ' The load fields were saved.' : ''}` }); }
      }
      const fresh = await fetchDispatchLoads(supabase, id);
      if (fresh.loads?.[0]) apply(fresh.loads[0]);
      setMsg({ err: false, text: 'Saved.' });
    } finally { setSaving(false); }
  }

  async function openRateCon() {
    setRcBusy(true); setMsg(null);
    try {
      const r = await rateConUrl(supabase, id);
      if (r.error) return setMsg({ err: true, text: r.error });
      window.open(r.url, '_blank', 'noopener');
    } finally { setRcBusy(false); }
  }

  const driverOpts = driverOptions(drivers, form?.assigned_driver_user_id, driversLoaded);

  return (
    <main style={s.main}>
      <p style={{ margin: '0 0 0.25rem' }}><Link href="/dispatch" style={{ ...s.link, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Dispatch</Link></p>
      {supabaseConfigError ? <p style={{ color: '#b91c1c' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to view this load.</p>
        : state.status === 'loading' ? <Loading label="Loading load…" />
        : state.status === 'error' ? <LoadError message={state.text} onRetry={fetchLoad} />
        : state.status === 'setup' ? <p style={s.muted}>{SETUP_MSG}</p>
        : state.status === 'not-member' ? <p style={s.muted}>The dispatch center is for management and dispatchers.</p>
        : state.status === 'missing' ? <p style={{ color: '#b91c1c' }}>Load not found.</p>
        : (
          <form onSubmit={save} noValidate data-testid="dispatch-load-form">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0' }}>{load.broker_load_number ? `Load #${load.broker_load_number}` : 'Load'}</h1>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusBadge status={load.status} />
                {load.has_rate_con && <button type="button" onClick={openRateCon} disabled={rcBusy} style={{ ...s.small, minHeight: 44, borderColor: '#2563eb', color: '#1d4ed8', fontWeight: 600 }}>📄 Rate con</button>}
              </span>
            </div>
            <p style={{ ...s.muted, marginTop: 0 }}>Rate {fmtMoney(load.rate)}{load.rate_per_mile != null ? ` · ${fmtMoney(load.rate_per_mile)}/mi` : ''}</p>

            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Load</h2>
              <div className="newload-grid">
                <label style={s.label}>Status
                  <select value={form.status} onChange={(e) => set('status')(e.target.value)} style={s.input}>
                    {STATUSES.map((x) => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}
                  </select>
                </label>
                <Field label="Broker" value={form.broker_name} onChange={set('broker_name')} error={errors.broker_name} />
                <Field label="Load #" value={form.broker_load_number} onChange={set('broker_load_number')} error={errors.broker_load_number} />
                <Field label="Rate ($)" inputMode="decimal" required value={form.rate} onChange={set('rate')} error={errors.rate} />
                <Field label="Miles" inputMode="numeric" value={form.total_miles} onChange={set('total_miles')} error={errors.total_miles} />
                <Field label="Weight (lb)" inputMode="numeric" value={form.weight} onChange={set('weight')} error={errors.weight} />
                <Field label="Commodity" value={form.commodity} onChange={set('commodity')} error={errors.commodity} />
                <Field label="Equipment" value={form.equipment_type} onChange={set('equipment_type')} error={errors.equipment_type} />
              </div>
              <div style={{ marginTop: '0.6rem', display: 'grid', gap: '0.6rem' }}>
                <Field label="Instructions" textarea value={form.special_instructions} onChange={set('special_instructions')} error={errors.special_instructions} />
                <Field label="Notes (the assigned driver sees these)" textarea value={form.notes} onChange={set('notes')} error={errors.notes} />
                {notesMayShowPay(form.notes) && !form.show_rate_to_driver && (
                  <p role="status" data-testid="notes-pay-warning" style={{ margin: 0, padding: '0.5rem 0.7rem', borderRadius: 8, background: '#fef3c7', color: '#92400e', fontSize: '0.85rem' }}>
                    These notes look like they mention pay. The driver can read notes even with “Show rate to driver” off, so remove any amounts you don’t want him to see.
                  </p>
                )}
              </div>
            </div>

            <div style={s.card} data-testid="dispatch-driver">
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Driver</h2>
              <label style={s.label}>Assigned driver
                {driverOpts.loading ? (
                  <select disabled aria-busy="true" data-testid="driver-picker-loading" value="" style={{ ...s.input, color: '#6b7280' }}><option value="">Loading drivers…</option></select>
                ) : (
                  <select value={form.assigned_driver_user_id} onChange={(e) => set('assigned_driver_user_id')(e.target.value)} style={s.input}>
                    <option value="">Not assigned</option>
                    {driverOpts.options.map((c) => <option key={c.user_id} value={c.user_id}>{driverLabel(c)}</option>)}
                  </select>
                )}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.show_rate_to_driver} onChange={(e) => set('show_rate_to_driver')(e.target.checked)} style={{ width: 22, height: 22 }} />
                <span>Show rate to driver</span>
              </label>
              <p data-testid="driver-rate-help" style={{ ...s.muted, margin: 0 }}>{driverRateHelp(form.show_rate_to_driver, load.show_rate_to_driver === true)}</p>
            </div>

            <div style={s.card} data-testid="dispatch-stops">
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Stops</h2>
              {stopErrors._list && <p role="alert" style={s.err}>{stopErrors._list}</p>}
              {stops.map((x, i) => {
                const e = stopErrors[x.key] || {};
                return (
                  <fieldset key={x.key} data-testid="dispatch-stop" style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '0.6rem 0.7rem', margin: '0 0 0.6rem' }}>
                    <legend style={{ fontWeight: 600, padding: '0 4px' }}>Stop {i + 1}</legend>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      <select aria-label={`Stop ${i + 1} type`} value={x.stop_type} onChange={(ev) => setStop(x.key, 'stop_type')(ev.target.value)} style={{ ...s.small, minHeight: 36 }}>
                        <option value="pickup">Pickup</option><option value="delivery">Delivery</option>
                      </select>
                      <button type="button" data-compact onClick={() => setStops((l) => moveStop(l, i, -1))} disabled={i === 0} style={s.small} aria-label={`Move stop ${i + 1} up`}>↑</button>
                      <button type="button" data-compact onClick={() => setStops((l) => moveStop(l, i, 1))} disabled={i === stops.length - 1} style={s.small} aria-label={`Move stop ${i + 1} down`}>↓</button>
                      <button type="button" data-compact onClick={() => setStops((l) => l.filter((y) => y.key !== x.key))} disabled={stops.length <= 2} style={{ ...s.small, color: '#b91c1c', borderColor: '#fecaca' }}>Remove</button>
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
            </div>

            {msg && <p role={msg.err ? 'alert' : 'status'} style={{ color: msg.err ? '#b91c1c' : '#15803d' }}>{msg.text}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 'calc(var(--nav-h) + 8px)', background: '#fff', padding: '0.5rem 0' }}>
              <button type="button" onClick={() => apply(load)} disabled={saving} style={{ ...s.small, minHeight: 44 }}>Discard changes</button>
              <button type="submit" disabled={saving} style={s.pri}>{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        )}
    </main>
  );
}
