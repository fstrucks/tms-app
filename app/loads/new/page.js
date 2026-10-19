'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SignInLink from '../../components/SignInLink';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import { useLoads } from '../LoadsData';
import { EMPTY_NEW_LOAD, buildNewLoad, createManualLoad } from '../../lib/loadNew';
import { seedLoad } from '../../lib/loadSeed';
import { fetchDriverChoices, driverLabel, driverRateHelp } from '../../lib/loadDriver';

// /loads/new: create a load by hand (no rate con). A static segment, so Next.js serves it before /loads/[id].
const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.85rem', color: 'var(--text)' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 4, background: 'var(--surface)', color: 'var(--text)' },
  err: { color: 'var(--danger)', fontSize: '0.8rem', margin: '0.2rem 0 0' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  link: { color: 'var(--primary)' },
};

function Field({ name, label, form, setForm, errors, type = 'text', inputMode, placeholder, required }) {
  return (
    <label style={s.label}>
      {label}{required ? ' *' : ''}
      <input name={name} type={type} inputMode={inputMode} placeholder={placeholder} value={form[name]}
        aria-invalid={errors[name] ? 'true' : undefined}
        onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
        style={{ ...s.input, ...(errors[name] ? { borderColor: 'var(--danger)' } : null) }} />
      {errors[name] && <p style={s.err}>{errors[name]}</p>}
    </label>
  );
}

export default function NewLoadPage() {
  const supabase = getSupabase();
  const router = useRouter();
  const list = useLoads();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [form, setForm] = useState(EMPTY_NEW_LOAD);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [drivers, setDrivers] = useState({ available: false, choices: [] }); // available once 20261018000600 is applied

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !user) return;
    let live = true;
    fetchDriverChoices(supabase).then((r) => { if (live) { if (r.error) console.error('[loads/new] drivers', r.error); setDrivers(r); } });
    return () => { live = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (saving) return;
    setSaveError(null);
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();
    const built = buildNewLoad(form, { userId: user?.id, timezone: tz });
    setErrors(built.errors);
    if (!built.load) return;
    setSaving(true);
    try {
      if (!(await hasSession(supabase))) return setSaveError('Your session has expired. Please sign in again.');
      const r = await createManualLoad(supabase, built);
      if (!r.ok) { console.error('[loads/new] create', r.cause); return setSaveError(r.error); }
      seedLoad(r.load); // the load page shows it at once, no loading skeleton
      list?.reload();
      router.replace(`/loads/${r.id}`);
    } finally { setSaving(false); }
  }

  const f = { form, setForm, errors };
  return (
    <main style={s.main}>
      <p style={{ margin: '0 0 0.25rem' }}>
        <Link href="/loads" style={{ ...s.link, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Loads</Link>
      </p>
      <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0' }}>New load</h1>
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to add a load.</p>
        : (
          <form onSubmit={submit} noValidate data-testid="new-load-form">
            <p style={{ ...s.muted, marginTop: 0 }}>Have a rate confirmation? Upload it on <Link href="/documents" style={s.link}>Documents</Link> and tap "Create load" instead. Fields marked * are required.</p>
            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Load</h2>
              <div className="newload-grid">
                <Field name="broker_name" label="Broker" placeholder="Sample Freight" {...f} />
                <Field name="broker_load_number" label="Load #" placeholder="SFB-100300" {...f} />
                <Field name="rate" label="Rate ($)" inputMode="decimal" placeholder="1,280" required {...f} />
                <Field name="miles" label="Miles" inputMode="numeric" placeholder="Blank = calculate" {...f} />
                <Field name="weight" label="Weight (lb)" inputMode="numeric" placeholder="38,500" {...f} />
                <Field name="commodity" label="Commodity" placeholder="Paper goods" {...f} />
                <Field name="equipment_type" label="Equipment" placeholder="Dry van" {...f} />
              </div>
            </div>
            {[['pu', 'Pickup'], ['del', 'Delivery']].map(([p, title]) => (
              <div key={p} style={s.card}>
                <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>{title}</h2>
                <div className="newload-grid">
                  <Field name={`${p}_company`} label="Company" {...f} />
                  <Field name={`${p}_address`} label="Street address" {...f} />
                  <Field name={`${p}_city`} label="City" required {...f} />
                  <Field name={`${p}_state`} label="State" placeholder="CA" required {...f} />
                  <Field name={`${p}_zip`} label="ZIP" inputMode="numeric" {...f} />
                  <Field name={`${p}_appt`} label="Appointment" type="datetime-local" {...f} />
                  {p === 'pu' && drivers.available && <Field name="pu_pickup_number" label="Pickup #" placeholder="PU-12345" {...f} />}
                </div>
              </div>
            ))}
            {drivers.available && (
              <div style={s.card} data-testid="new-load-driver">
                <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Driver</h2>
                <label style={s.label}>Assigned driver
                  <select name="driver_user_id" value={form.driver_user_id} onChange={(e) => setForm((x) => ({ ...x, driver_user_id: e.target.value }))} style={s.input}>
                    <option value="">Not assigned</option>
                    {drivers.choices.map((c) => <option key={c.user_id} value={c.user_id}>{driverLabel(c)}</option>)}
                  </select>
                </label>
                {drivers.choices.length === 0 && <p style={{ ...s.muted, margin: '0.3rem 0 0' }}>No drivers on your company yet. Invite one from the account menu.</p>}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 6, cursor: 'pointer' }}>
                  <input type="checkbox" name="show_rate_to_driver" checked={form.show_rate_to_driver === true}
                    onChange={(e) => setForm((x) => ({ ...x, show_rate_to_driver: e.target.checked }))} style={{ width: 22, height: 22 }} />
                  <span>Show rate to driver</span>
                </label>
                <p data-testid="driver-rate-help" style={{ ...s.muted, margin: 0 }}>{driverRateHelp(form.show_rate_to_driver === true)}</p>
              </div>
            )}
            {saveError && <p role="alert" style={{ color: 'var(--danger)' }}>{saveError}</p>}
            {Object.keys(errors).length > 0 && <p role="alert" style={{ color: 'var(--danger)' }}>Please fix the highlighted fields.</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Link href="/loads" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', color: 'var(--text)', textDecoration: 'none' }}>Cancel</Link>
              <button type="submit" disabled={saving} style={{ minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, fontSize: 16 }}>
                {saving ? 'Creating…' : 'Create load'}
              </button>
            </div>
          </form>
        )}
    </main>
  );
}
