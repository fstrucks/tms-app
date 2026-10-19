'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SignInLink from '../../components/SignInLink';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import { useLoads } from '../LoadsData';
import { EMPTY_NEW_LOAD, buildNewLoad, createManualLoad } from '../../lib/loadNew';
import { seedLoad } from '../../lib/loadSeed';

// /loads/new: create a load by hand (no rate con). A static segment, so Next.js serves it before /loads/[id].
const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.85rem', color: '#374151' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid #d1d5db', marginTop: 4, background: '#fff', color: '#111827' },
  err: { color: '#b91c1c', fontSize: '0.8rem', margin: '0.2rem 0 0' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  link: { color: '#2563eb' },
};

function Field({ name, label, form, setForm, errors, type = 'text', inputMode, placeholder, required }) {
  return (
    <label style={s.label}>
      {label}{required ? ' *' : ''}
      <input name={name} type={type} inputMode={inputMode} placeholder={placeholder} value={form[name]}
        aria-invalid={errors[name] ? 'true' : undefined}
        onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
        style={{ ...s.input, ...(errors[name] ? { borderColor: '#b91c1c' } : null) }} />
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

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'INITIAL_SESSION') setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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
      {supabaseConfigError ? <p style={{ color: '#b91c1c' }}>{supabaseConfigError}</p>
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
                </div>
              </div>
            ))}
            {saveError && <p role="alert" style={{ color: '#b91c1c' }}>{saveError}</p>}
            {Object.keys(errors).length > 0 && <p role="alert" style={{ color: '#b91c1c' }}>Please fix the highlighted fields.</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Link href="/loads" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', padding: '0 14px', borderRadius: 8, border: '1px solid #d1d5db', color: '#111827', textDecoration: 'none' }}>Cancel</Link>
              <button type="submit" disabled={saving} style={{ minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: 16 }}>
                {saving ? 'Creating…' : 'Create load'}
              </button>
            </div>
          </form>
        )}
    </main>
  );
}
