'use client';

import { useEffect, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { PROFILE_FIELDS, validateProfile, maskEin } from '../lib/companyFields';
import { ROLE_LABELS, canEdit as roleCanEdit, canSign as roleCanSign } from '../lib/companyRoles';
import { VISUALLY_HIDDEN } from '../components/UploadMenu';
import CompanyInsurance from './CompanyInsurance';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 560, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  label: { display: 'block', margin: '0.75rem 0 0.35rem', fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' },
  ro: { padding: '0.6rem 0', fontSize: '1rem', color: '#111827', minHeight: 24 },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem', cursor: 'pointer' },
  pick: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 8, border: '2px solid #2563eb', color: '#1d4ed8', background: '#eff6ff', fontWeight: 600, cursor: 'pointer', touchAction: 'manipulation', marginTop: '0.5rem' },
  err: { color: '#b91c1c', fontSize: 14, margin: '0.25rem 0 0' },
  badge: { display: 'inline-block', padding: '0.15rem 0.6rem', borderRadius: 999, background: '#f1f5f9', fontSize: 14, fontWeight: 600 },
};
const HALF = new Set(['city', 'state', 'postal_code', 'mc_number', 'dot_number']);
const SIG_INPUT = 'company-signature-file';

export default function CompanyProfilePage() {
  const [state, setState] = useState({ loading: true });
  const [form, setForm] = useState({});
  const [ein, setEin] = useState('');
  const [errors, setErrors] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sigFile, setSigFile] = useState(null);
  const [sigPreview, setSigPreview] = useState(null);

  async function api(method, body) {
    const sb = getSupabase();
    if (!sb) throw new Error(supabaseConfigError);
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) { const e = new Error('Sign in to see your company profile.'); e.signedOut = true; throw e; }
    const r = await fetch('/api/company-profile', { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.errors = j.errors; throw e; }
    return j;
  }
  function apply(j) {
    setState({ ...j, loading: false });
    const f = {}; for (const [k] of PROFILE_FIELDS) f[k] = j.profile?.[k] || ''; setForm(f);
  }
  useEffect(() => { api('GET').then(apply, (e) => setState({ loading: false, error: e.message, signedOut: e.signedOut })); }, []);
  useEffect(() => () => { if (sigPreview) URL.revokeObjectURL(sigPreview); }, [sigPreview]);

  const role = state.role;
  const editable = roleCanEdit(role);
  const signable = roleCanSign(role);

  async function save(e) {
    e.preventDefault(); setMsg(null);
    const body = { ...form, ...(ein ? { ein } : {}) };
    const v = validateProfile(body);
    setErrors(v); if (Object.keys(v).length) return;
    setBusy(true);
    try { apply(await api('PUT', body)); setEin(''); setMsg('Company profile saved.'); }
    catch (err) { setErrors(err.errors || {}); setMsg(err.message); }
    finally { setBusy(false); }
  }
  async function sign() {
    setMsg(null);
    if (!sigFile) return setMsg('Choose a signature image first.');
    if (!form.signer_name.trim()) return setErrors({ signer_name: 'Required to sign.' });
    setBusy(true);
    try {
      const sb = getSupabase();
      const { data } = await sb.auth.getSession();
      const uid = data.session.user.id;
      const ext = (sigFile.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${uid}/company/signature-${Date.now()}.${ext}`;
      const { error } = await sb.storage.from('documents').upload(path, sigFile, { contentType: sigFile.type || 'image/png' });
      if (error) throw new Error('Could not upload the signature.');
      apply(await api('PUT', { ...form, sign: true, signature_path: path }));
      setSigFile(null); setSigPreview(null); setMsg('Signed. Your signature is saved for packets.');
    } catch (err) { setErrors(err.errors || {}); setMsg(err.message); }
    finally { setBusy(false); }
  }
  function onSig(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp|heic|heif)$/i.test(f.type || 'image/png')) return setMsg('Use a PNG or JPG image of your signature.');
    setSigFile(f); setSigPreview(URL.createObjectURL(f));
  }

  if (state.loading) return <main style={s.main}><p>Loading company profile…</p></main>;
  if (state.error) return <main style={s.main}><h1>Company profile</h1><p role="alert" style={s.err}>{state.error}</p>{state.signedOut && <a href="/login?next=/company">Sign in</a>}</main>;

  const p = state.profile;
  return (
    <main style={s.main}>
      <h1 style={{ marginBottom: '0.25rem' }}>Company profile</h1>
      <p style={{ color: '#6b7280', marginTop: 0 }}>Used to fill out broker carrier packets. <span style={s.badge}>Your role: {ROLE_LABELS[role] || role}</span></p>
      {!editable && <p role="status" style={{ background: '#fef3c7', borderRadius: 8, padding: '0.6rem 0.8rem' }}>Drivers can view the company profile. Ask the owner, dispatcher or management to make changes or sign.</p>}

      <form onSubmit={save} noValidate>
        <section style={s.card}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Company info</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 0.75rem' }}>
            {PROFILE_FIELDS.filter(([k]) => !k.startsWith('signer_')).map(([k, label]) => (
              <div key={k} style={{ flex: HALF.has(k) ? '1 1 140px' : '1 1 100%', minWidth: 0 }}>
                <label htmlFor={`cp-${k}`} style={s.label}>{label}</label>
                {editable
                  ? <input id={`cp-${k}`} style={{ ...s.input, ...(errors[k] ? { borderColor: '#b91c1c' } : null) }} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      inputMode={['dot_number', 'postal_code', 'phone'].includes(k) ? 'numeric' : k === 'email' ? 'email' : undefined}
                      autoCapitalize={k === 'state' ? 'characters' : undefined} maxLength={k === 'state' ? 2 : undefined} aria-invalid={!!errors[k]} />
                  : <div id={`cp-${k}`} style={s.ro}>{form[k] || '—'}</div>}
                {errors[k] && <p style={s.err}>{errors[k]}</p>}
              </div>
            ))}
          </div>
          <label htmlFor="cp-ein" style={s.label}>EIN / TIN</label>
          {editable
            ? <input id="cp-ein" style={{ ...s.input, ...(errors.ein ? { borderColor: '#b91c1c' } : null) }} value={ein} onChange={(e) => setEin(e.target.value)} inputMode="numeric" autoComplete="off"
                placeholder={p?.has_ein ? `Saved ${maskEin(p.ein_last4)} — type to replace` : '12-3456789'} />
            : <div id="cp-ein" style={s.ro}>{p?.has_ein ? maskEin(p.ein_last4) : '—'}</div>}
          {errors.ein && <p style={s.err}>{errors.ein}</p>}
          <p style={{ color: '#6b7280', fontSize: 13, margin: '0.35rem 0 0' }}>Encrypted before it's stored. Only the last 4 digits are shown.</p>
        </section>

        <section style={s.card}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Authorized signer</h2>
          {PROFILE_FIELDS.filter(([k]) => k.startsWith('signer_')).map(([k, label]) => (
            <div key={k}>
              <label htmlFor={`cp-${k}`} style={s.label}>{label}</label>
              {editable
                ? <input id={`cp-${k}`} style={{ ...s.input, ...(errors[k] ? { borderColor: '#b91c1c' } : null) }} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                : <div id={`cp-${k}`} style={s.ro}>{form[k] || '—'}</div>}
              {errors[k] && <p style={s.err}>{errors[k]}</p>}
            </div>
          ))}
          <p style={{ margin: '0.75rem 0 0' }}>{p?.signed_at ? `Signature on file (saved ${new Date(p.signed_at).toLocaleDateString()}).` : 'No signature on file yet.'}</p>
          {signable && (
            <div>
              {/* iOS-safe: label htmlFor + visually hidden input. no hidden-by-display, no programmatic clicks. */}
              <input id={SIG_INPUT} type="file" accept="image/png,image/jpeg,image/webp,image/heic" onChange={onSig} style={VISUALLY_HIDDEN} tabIndex={-1} disabled={busy} />
              <label htmlFor={SIG_INPUT} role="button" style={{ ...s.pick, ...(busy ? { opacity: 0.5, pointerEvents: 'none' } : null) }}>{sigFile ? 'Choose a different signature image' : '✍️ Choose signature image'}</label>
              {sigPreview && <img src={sigPreview} alt="Signature preview" style={{ display: 'block', maxWidth: '100%', maxHeight: 120, margin: '0.5rem 0', border: '1px solid #e5e7eb', borderRadius: 8 }} />}
              <button type="button" style={{ ...s.btn, background: '#059669', ...(busy || !sigFile ? { opacity: 0.6 } : null) }} disabled={busy || !sigFile} onClick={sign}>Sign as {form.signer_name || 'authorized signer'}</button>
            </div>
          )}
        </section>

        {editable && <button type="submit" style={{ ...s.btn, ...(busy ? { opacity: 0.6 } : null) }} disabled={busy}>{busy ? 'Saving…' : 'Save company profile'}</button>}
        {msg && <p role="status" style={{ marginTop: '0.75rem' }}>{msg}</p>}
      </form>
      {p && <CompanyInsurance />}
    </main>
  );
}
