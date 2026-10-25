'use client';

// /dispatch/<id>: management and dispatchers edit one of the owner's loads: every load field (notes included),
// the assigned driver, "Show rate to driver", and the stops (add, remove, reorder). Saves go through
// public.dispatch_update_load / public.dispatch_save_stops (SECURITY DEFINER, role-checked in the database).
// Drivers never get here with data: dispatch_loads() returns nothing to them.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import SignInLink from '../../components/SignInLink';
import StopsEditor from '../../components/StopsEditor';
import LoadDocsCard from '../../components/LoadDocsCard';
import { Loading, LoadError } from '../../components/DataState';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import { StatusBadge, fmtMoney } from '../../lib/loads';
import { isLoadId } from '../../lib/loadNew';
import { fetchDriverChoices, driverLabel, driverRateHelp, driverOptions, withOwnerDriver } from '../../lib/loadDriver';
import {
  STATUSES, SETUP_MSG, resolveDispatchAccess, fetchDispatchLoads, loadToForm, formToPatch, stopsToForm, formToStops,
  saveLoad, saveStops, rateConUrl, notesMayShowPay,
  notMemberCopy,
} from '../../lib/dispatch';
import { useRetryWhenOnline, loadWithOneRetry, withTimeout } from '../../lib/onlineRetry';
import { dispatchLoad, showDispatchButton, formStatusOnDriverPick, formStatusOnStatusPick } from '../../lib/autoDispatch';

const s = {
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 820, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.85rem', color: 'var(--text)' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 4, background: 'var(--surface)', color: 'var(--text)' },
  err: { color: 'var(--danger)', fontSize: '0.8rem', margin: '0.2rem 0 0' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  link: { color: 'var(--primary)' },
  small: { minHeight: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 14, cursor: 'pointer' },
  pri: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, fontSize: 16, cursor: 'pointer' },
};

function Field({ label, value, onChange, error, type = 'text', inputMode, placeholder, required, textarea }) {
  const style = { ...s.input, ...(error ? { borderColor: 'var(--danger)' } : null), ...(textarea ? { minHeight: 96, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' } : null) };
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

  // One pass. → true when it ended in an error state (one automatic retry, then Retry / back-online).
  async function fetchLoadOnce({ auto = false } = {}) {
    if (!auto) { setState({ status: 'loading' }); setMsg(null); }
    const fail = (text) => { setState({ status: 'error', text }); return true; };
    if (!isLoadId(id)) { setState({ status: 'missing' }); return false; }
    if (!(await hasSession(supabase))) return fail('Your session has expired or is still loading. Tap Retry, or sign in again.');
    const acc = await resolveDispatchAccess(supabase);
    if (acc.status === 'setup') { setState({ status: 'setup' }); return false; }
    if (acc.status === 'unknown') { console.error('[dispatch] access', acc.error?.code || '', acc.error?.message || ''); return fail('Couldn’t load this load. Check your connection and tap Retry.'); }
    if (acc.status === 'not-member') { setState({ status: 'not-member', copy: notMemberCopy(acc.roles) }); return false; }
    const res = await fetchDispatchLoads(supabase, id);
    if (res.setup) { setState({ status: 'setup' }); return false; }
    if (res.error) { console.error('[dispatch] load', res.error); return fail('Couldn’t load this load. Check your connection and tap Retry.'); }
    const load = res.loads[0];
    if (!load) { setState({ status: 'missing' }); return false; }
    setDriversLoaded(false);
    apply(load);
    const drv = await fetchDriverChoices(supabase, load.owner_id);
    if (drv.error) console.error('[dispatch] drivers', drv.error);
    setDrivers(withOwnerDriver(drv.choices, load.owner_id));
    setDriversLoaded(true);
    return false;
  }
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const fetchLoad = () => loadWithOneRetry((o) => withTimeout(fetchLoadOnce(o), undefined, () => { setState({ status: 'error', text: 'Couldn’t load this load. Check your connection and tap Retry.' }); return true; }), { isLive: () => live.current });
  useRetryWhenOnline(state.status === 'error', () => withTimeout(fetchLoadOnce({ auto: true }), undefined, () => true)); // quiet probe

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
  function setDriver(nextDriver) {
    setForm((f) => ({
      ...f,
      assigned_driver_user_id: nextDriver,
      status: formStatusOnDriverPick({
        savedStatus: load.status, savedDriver: load.assigned_driver_user_id, nextDriver, formStatus: f.status,
      }),
    }));
    setMsg(null);
  }
  function setStatus(pickedStatus) {
    setForm((f) => ({
      ...f,
      status: formStatusOnStatusPick({
        savedStatus: load.status, savedDriver: load.assigned_driver_user_id, formDriver: f.assigned_driver_user_id, pickedStatus,
      }),
    }));
    setMsg(null);
  }

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
      setMsg({ err: false, text: load.status === 'booked' && p.patch.status === 'dispatched' ? 'Saved and dispatched.' : 'Saved.' });
    } finally { setSaving(false); }
  }

  const canDispatchNow = !!(load && form && showDispatchButton({ status: load.status, driverId: load.assigned_driver_user_id })
    && (form.assigned_driver_user_id || '') === (load.assigned_driver_user_id || '')
    && form.status === load.status);

  async function dispatchNow() {
    if (saving || !canDispatchNow) return;
    setMsg(null);
    const p = formToPatch(form, load);
    const st = formToStops(stops, { browserTz });
    const stopsChanged = !st.payload || JSON.stringify(st.payload) !== original;
    if (!p.patch || Object.keys(p.patch).length || stopsChanged) return setMsg({ err: true, text: 'Save or discard your other changes, then tap Dispatch.' });
    setSaving(true);
    try {
      if (!(await hasSession(supabase))) return setMsg({ err: true, text: 'Your session has expired. Please sign in again.' });
      const r = await dispatchLoad(supabase, { id, status: load.status, channel: 'staff', saveStaff: saveLoad });
      if (!r.ok) { console.error('[dispatch] dispatch', r.error); return setMsg({ err: true, text: r.message || 'Couldn’t dispatch. Please try again.' }); }
      const fresh = await fetchDispatchLoads(supabase, id);
      if (fresh.loads?.[0]) apply(fresh.loads[0]);
      setMsg({ err: false, text: 'Dispatched.' });
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
    <main style={{ ...s.main, paddingBottom: 'calc(1rem + var(--fab-space))' }}>
      <p style={{ margin: '0 0 0.25rem' }}><Link href="/dispatch" style={{ ...s.link, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Dispatch</Link></p>
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to view this load.</p>
        : state.status === 'loading' ? <Loading label="Loading load…" />
        : state.status === 'error' ? <LoadError message={state.text} onRetry={fetchLoad} />
        : state.status === 'setup' ? <p style={s.muted}>{SETUP_MSG}</p>
        : state.status === 'not-member' ? <p style={s.muted} data-testid="dispatch-not-member">{state.copy.text} <Link href={state.copy.href} style={s.link}>{state.copy.linkText}</Link>.</p>
        : state.status === 'missing' ? <p style={{ color: 'var(--danger)' }}>Load not found.</p>
        : (
          <form onSubmit={save} noValidate data-testid="dispatch-load-form">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0' }}>{load.broker_load_number ? `Load #${load.broker_load_number}` : 'Load'}</h1>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusBadge status={load.status} />
                {load.has_rate_con && <button type="button" onClick={openRateCon} disabled={rcBusy} style={{ ...s.small, minHeight: 44, borderColor: 'var(--primary)', color: 'var(--primary)', fontWeight: 600 }}>📄 Rate con</button>}
              </span>
            </div>
            <p style={{ ...s.muted, marginTop: 0 }}>Rate {fmtMoney(load.rate)}{load.rate_per_mile != null ? ` · ${fmtMoney(load.rate_per_mile)}/mi` : ''}</p>

            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Load</h2>
              <div className="newload-grid">
                <div>
                  <label style={s.label}>Status
                    <select value={form.status} onChange={(e) => setStatus(e.target.value)} style={s.input}>
                      {STATUSES.map((x) => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}
                    </select>
                  </label>
                  {canDispatchNow && (
                    <button type="button" data-testid="dispatch-load-btn" disabled={saving} onClick={dispatchNow}
                      style={{ ...s.pri, marginTop: 8, width: '100%' }}>Dispatch</button>
                  )}
                </div>
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
                  <p role="status" data-testid="notes-pay-warning" style={{ margin: 0, padding: '0.5rem 0.7rem', borderRadius: 8, background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: '0.85rem' }}>
                    These notes look like they mention pay. The driver can read notes even with “Show rate to driver” off, so remove any amounts you don’t want them to see.
                  </p>
                )}
              </div>
            </div>

            <div style={s.card} data-testid="dispatch-driver">
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Driver</h2>
              <label style={s.label}>Assigned driver
                {driverOpts.loading ? (
                  <select disabled aria-busy="true" data-testid="driver-picker-loading" value="" style={{ ...s.input, color: 'var(--text-muted)' }}><option value="">Loading drivers…</option></select>
                ) : (
                  <select value={form.assigned_driver_user_id} onChange={(e) => setDriver(e.target.value)} style={s.input}>
                    <option value="">Not assigned</option>
                    {driverOpts.options.map((c) => <option key={c.user_id} value={c.user_id}>{driverLabel(c)}</option>)}
                  </select>
                )}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 6, cursor: form.assigned_driver_user_id ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={form.show_rate_to_driver && !!form.assigned_driver_user_id} disabled={!form.assigned_driver_user_id} onChange={(e) => set('show_rate_to_driver')(e.target.checked)} style={{ width: 22, height: 22 }} />
                <span>Show rate to driver</span>
              </label>
              <p data-testid="driver-rate-help" style={{ ...s.muted, margin: 0 }}>{form.assigned_driver_user_id ? driverRateHelp(form.show_rate_to_driver, load.show_rate_to_driver === true) : 'Pick a driver to choose whether they see the rate.'}</p>
            </div>

            <StopsEditor stops={stops} setStops={setStops} stopErrors={stopErrors} browserTz={browserTz} onEdit={() => setMsg(null)} />

            {msg && <p role={msg.err ? 'alert' : 'status'} style={{ color: msg.err ? 'var(--danger)' : 'var(--success)' }}>{msg.text}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom) + var(--fab-space))', zIndex: 61, background: 'var(--surface)', padding: '0.5rem 0' }}>
              <button type="button" onClick={() => apply(load)} disabled={saving} style={{ ...s.small, minHeight: 44 }}>Discard changes</button>
              <button type="submit" disabled={saving} style={s.pri}>{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        )}
      {/* PR #110: the load's documents (BOLs, scale tickets, …) for Dispatchers / Management, outside the form. */}
      {user && state.status === 'ready' && load && (
        <LoadDocsCard supabase={supabase} loadId={load.id} userId={user.id} cardStyle={s.card}
          loadLabel={[load.broker_load_number ? `#${load.broker_load_number}` : 'This load', load.broker_name].filter(Boolean).join(' · ')} />
      )}
    </main>
  );
}
