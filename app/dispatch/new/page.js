'use client';
import { activeDispatchCompany } from '../../lib/activeCompanyClient';

// /dispatch/new: management and dispatchers create a load for the company (Marc asked for it, via Sam, Oct 19 2026).
// The load is saved under the company OWNER's account through public.dispatch_create_load (migration
// 20261019000100, SECURITY DEFINER, role-checked in the database), with its stops (2–20) in the same call.
// Owners create loads in /loads/new; drivers and non-members get the same copy as /dispatch.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SignInLink from '../../components/SignInLink';
import StopsEditor, { Field, STOP_STYLES } from '../../components/StopsEditor';
import { Loading, LoadError } from '../../components/DataState';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import { fetchDriverChoices, driverLabel, driverRateHelp, driverOptions } from '../../lib/loadDriver';
import {
  STATUSES, SETUP_MSG, fetchDispatchContext, loadToForm, blankStop, formToStops, formToNewLoad, createLoad,
  notesMayShowPay, notMemberCopy, fetchMyRoles,
} from '../../lib/dispatch';

const s = {
  ...STOP_STYLES,
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 820, margin: '0 auto' },
  link: { color: 'var(--primary)' },
  pri: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, fontSize: 16, cursor: 'pointer' },
};

export default function DispatchNewLoadPage() {
  const supabase = getSupabase();
  const router = useRouter();
  const browserTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } }, []);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState({ status: 'loading' });
  const [form, setForm] = useState(() => loadToForm({ status: 'booked' }));
  const [stops, setStops] = useState(() => [blankStop('pickup', browserTz), blankStop('delivery', browserTz)]);
  const [errors, setErrors] = useState({});
  const [stopErrors, setStopErrors] = useState({});
  const [drivers, setDrivers] = useState([]);
  const [driversLoaded, setDriversLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  async function load() {
    setState({ status: 'loading' });
    if (!(await hasSession(supabase))) return setState({ status: 'error', text: 'Your session has expired or is still loading. Tap Retry, or sign in again.' });
    const ctx = await fetchDispatchContext(supabase);
    if (ctx.setup) return setState({ status: 'setup', text: SETUP_MSG });
    if (ctx.error) { console.error('[dispatch new] context', ctx.error); return setState({ status: 'error', text: 'Couldn’t load the dispatch center.' }); }
    if (!ctx.companies.length) return setState({ status: 'not-member', copy: notMemberCopy(await fetchMyRoles(supabase)) });
    const company = await activeDispatchCompany(ctx.companies);
    setState({ status: 'ready', company });
    setDriversLoaded(false);
    const drv = await fetchDriverChoices(supabase, company.owner_id);
    if (drv.error) console.error('[dispatch new] drivers', drv.error);
    setDrivers(drv.choices || []);
    setDriversLoaded(true);
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && u) setTimeout(() => load(), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setMsg(null); };

  async function save(e) {
    e.preventDefault();
    if (saving || state.status !== 'ready') return;
    setMsg(null);
    const l = formToNewLoad(form);
    const st = formToStops(stops, { browserTz });
    setErrors(l.errors || {}); setStopErrors(st.errors || {});
    if (!l.load || !st.payload) return setMsg({ err: true, text: 'Please fix the highlighted fields.' });
    setSaving(true);
    try {
      if (!(await hasSession(supabase))) return setMsg({ err: true, text: 'Your session has expired. Please sign in again.' });
      const r = await createLoad(supabase, state.company.owner_id, l.load, st.payload);
      if (!r.ok) { console.error('[dispatch new] create', r.cause); return setMsg({ err: true, text: r.error }); }
      router.push(`/dispatch/${r.id}`);
    } finally { setSaving(false); }
  }

  const driverOpts = driverOptions(drivers, form.assigned_driver_user_id, driversLoaded);

  return (
    <main style={s.main}>
      <p style={{ margin: '0 0 0.25rem' }}><Link href="/dispatch" style={{ ...s.link, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Dispatch</Link></p>
      <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0' }}>New load</h1>
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to create a load.</p>
        : state.status === 'loading' ? <Loading label="Loading…" />
        : state.status === 'error' ? <LoadError message={state.text} onRetry={load} />
        : state.status === 'setup' ? <p style={s.muted}>{state.text}</p>
        : state.status === 'not-member' ? <p style={s.muted} data-testid="dispatch-not-member">{state.copy.text} <Link href={state.copy.href} style={s.link}>{state.copy.linkText}</Link>.</p>
        : (
          <form onSubmit={save} noValidate data-testid="dispatch-new-form">
            <p style={{ ...s.muted, marginTop: 0 }} data-testid="dispatch-new-company">For {state.company.company_name}. The load is saved to the owner’s account, so the owner sees it in Loads.</p>
            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Load</h2>
              <div className="newload-grid">
                <label style={s.label}>Status
                  <select value={form.status} onChange={(e) => set('status')(e.target.value)} style={s.input}>
                    {STATUSES.map((x) => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}
                  </select>
                </label>
                <Field label="Broker" required value={form.broker_name} onChange={set('broker_name')} error={errors.broker_name} />
                <Field label="Load #" value={form.broker_load_number} onChange={set('broker_load_number')} error={errors.broker_load_number} />
                <Field label="Rate ($)" inputMode="decimal" required placeholder="e.g. 1,280" value={form.rate} onChange={set('rate')} error={errors.rate} />
                <Field label="Miles" inputMode="numeric" value={form.total_miles} onChange={set('total_miles')} error={errors.total_miles} />
                <Field label="Weight (lb)" inputMode="numeric" value={form.weight} onChange={set('weight')} error={errors.weight} />
                <Field label="Commodity" value={form.commodity} onChange={set('commodity')} error={errors.commodity} />
                <Field label="Equipment" placeholder="e.g. 53' dry van" value={form.equipment_type} onChange={set('equipment_type')} error={errors.equipment_type} />
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
                  <select value={form.assigned_driver_user_id} onChange={(e) => set('assigned_driver_user_id')(e.target.value)} style={s.input}>
                    <option value="">Not assigned</option>
                    {driverOpts.options.map((c) => <option key={c.user_id} value={c.user_id}>{driverLabel(c)}</option>)}
                  </select>
                )}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 6, cursor: form.assigned_driver_user_id ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={form.show_rate_to_driver && !!form.assigned_driver_user_id} disabled={!form.assigned_driver_user_id} onChange={(e) => set('show_rate_to_driver')(e.target.checked)} style={{ width: 22, height: 22 }} />
                <span>Show rate to driver</span>
              </label>
              <p data-testid="driver-rate-help" style={{ ...s.muted, margin: 0 }}>{form.assigned_driver_user_id ? driverRateHelp(form.show_rate_to_driver) : 'Pick a driver to choose whether they see the rate.'}</p>
            </div>

            <StopsEditor stops={stops} setStops={setStops} stopErrors={stopErrors} browserTz={browserTz} onEdit={() => setMsg(null)} testId="dispatch-new-stops" />

            {msg && <p role={msg.err ? 'alert' : 'status'} style={{ color: msg.err ? 'var(--danger)' : 'var(--success)' }}>{msg.text}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom) + 60px)', background: 'var(--surface)', padding: '0.5rem 0' }}>
              <Link href="/dispatch" style={{ ...s.small, minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: 'var(--text)' }}>Cancel</Link>
              <button type="submit" disabled={saving} style={s.pri} data-testid="dispatch-new-save">{saving ? 'Saving…' : 'Create load'}</button>
            </div>
          </form>
        )}
    </main>
  );
}
