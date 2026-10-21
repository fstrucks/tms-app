'use client';
// Company page → Billing (invoicing PR 1). Invoice settings (next number, Net terms, remit-to, default factoring
// company), optional logo, brokers (billing emails, terms, NOA on file) and factoring companies.
// Owner + Management edit. Dispatchers see it read-only. Drivers don't see this card (the server says 403).
import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import ConfirmButton from '../components/ui/ConfirmButton';
import { termsLabel, PACKET_FORMATS, checkLogo } from '../lib/invoice';

const { call: api, token } = makeApi(() => getSupabase()?.auth);
const s = {
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  row: { border: '1px solid var(--divider)', borderRadius: 10, padding: '0.75rem', marginTop: '0.6rem' },
  muted: { color: 'var(--text-muted)', fontSize: 14 },
  btn: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' },
  primary: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, cursor: 'pointer' },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' },
  label: { display: 'block', marginTop: '0.6rem' },
  err: { color: 'var(--danger)', fontSize: 14, margin: '0.4rem 0 0' },
  h3: { fontSize: '1rem', margin: '1rem 0 0' },
};
const BROKER_EMPTY = { name: '', mc_number: '', address: '', billing_emails: '', terms_days: '', quick_pay_terms: '', noa_on_file: false, notes: '' };
const FACTOR_EMPTY = { name: '', submission_email: '', portal_url: '', remit_to: '', cutoff_time: '', packet_format: 'merged', notes: '' };

function Field({ label, children }) { return <label style={s.label}><span style={s.muted}>{label}</span>{children}</label>; }

function EntityForm({ kind, initial, onCancel, onSaved }) {
  const [f, setF] = useState(() => ({ ...(kind === 'brokers' ? BROKER_EMPTY : FACTOR_EMPTY), ...initial,
    ...(kind === 'brokers' ? { billing_emails: (initial?.billing_emails || []).join(', '), terms_days: initial?.terms_days ?? '' } : {}) }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    const path = initial?.id ? `/api/billing/${kind}/${initial.id}` : `/api/billing/${kind}`;
    const j = await api(path, { method: initial?.id ? 'PATCH' : 'POST', body: JSON.stringify(f) });
    setBusy(false);
    if (j.error) return setErr(j.error);
    onSaved();
  }
  return (
    <form onSubmit={submit} style={s.row} data-testid={`${kind}-form`}>
      <Field label={kind === 'brokers' ? 'Broker name' : 'Factoring company name'}><input style={s.input} value={f.name} onChange={set('name')} required /></Field>
      {kind === 'brokers' ? (<>
        <Field label="MC number"><input style={s.input} value={f.mc_number || ''} onChange={set('mc_number')} /></Field>
        <Field label="Billing address"><textarea style={{ ...s.input, minHeight: 64, padding: 10 }} value={f.address || ''} onChange={set('address')} /></Field>
        <Field label="Billing emails (comma separated)"><input style={s.input} inputMode="email" value={f.billing_emails} onChange={set('billing_emails')} placeholder="ap@example.com" /></Field>
        <Field label="Payment terms in days (blank = company default)"><input style={s.input} inputMode="numeric" value={f.terms_days} onChange={set('terms_days')} placeholder="30" /></Field>
        <Field label="Quick-pay terms (optional)"><input style={s.input} value={f.quick_pay_terms || ''} onChange={set('quick_pay_terms')} /></Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: '0.4rem' }}>
          <input type="checkbox" checked={!!f.noa_on_file} onChange={set('noa_on_file')} style={{ width: 22, height: 22 }} />
          <span>NOA on file (this broker pays my factoring company)</span>
        </label>
      </>) : (<>
        <Field label="Submission email"><input style={s.input} inputMode="email" value={f.submission_email || ''} onChange={set('submission_email')} /></Field>
        <Field label="Upload portal link (optional)"><input style={s.input} value={f.portal_url || ''} onChange={set('portal_url')} placeholder="https://" /></Field>
        <Field label="Remit-to (printed on factored invoices)"><textarea style={{ ...s.input, minHeight: 64, padding: 10 }} value={f.remit_to || ''} onChange={set('remit_to')} /></Field>
        <Field label="Daily cutoff (optional)"><input style={s.input} value={f.cutoff_time || ''} onChange={set('cutoff_time')} placeholder="11:00 AM CT" /></Field>
        <Field label="Paperwork format">
          <select style={s.input} value={f.packet_format} onChange={set('packet_format')}>{PACKET_FORMATS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </Field>
      </>)}
      <Field label="Notes"><input style={s.input} value={f.notes || ''} onChange={set('notes')} /></Field>
      {err && <p role="alert" style={s.err}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: '0.75rem' }}>
        <button type="button" style={s.btn} onClick={onCancel}>Cancel</button>
        <button type="submit" style={s.primary} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

export default function CompanyBilling() {
  const [st, setSt] = useState({ loading: true });
  const [edit, setEdit] = useState(null); // { kind, item }
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [logoUrl, setLogoUrl] = useState(null);

  const load = useCallback(async () => {
    const j = await api('/api/billing');
    if (j.status === 403) return setSt({ hidden: true });
    if (j.error) return setSt({ error: j.error, setupNeeded: j.setupNeeded });
    setSt(j);
    setForm({ default_terms_days: String(j.settings?.default_terms_days ?? 30), default_factor_id: j.settings?.default_factor_id || '', remit_to: j.settings?.remit_to || '' });
    if (j.settings?.has_logo) { const l = await api('/api/billing/logo'); setLogoUrl(l.url || null); } else setLogoUrl(null);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (st.hidden) return null;
  if (st.loading) return <section style={s.card}><h2 style={{ margin: 0, fontSize: '1.1rem' }}>Billing</h2><p style={s.muted}>Loading…</p></section>;
  if (st.error) return <section style={s.card}><h2 style={{ margin: 0, fontSize: '1.1rem' }}>Billing</h2><p role="alert" style={st.setupNeeded ? s.muted : s.err}>{st.error}</p></section>;
  const ro = !st.canEdit;
  const factorName = (id) => st.factors.find((f) => f.id === id)?.name;

  async function saveSettings(e) {
    e.preventDefault(); setMsg(null); setErr(null);
    const j = await api('/api/billing', { method: 'PATCH', body: JSON.stringify(form) });
    if (j.error) return setErr(j.error);
    setMsg('Billing settings saved.'); load();
  }
  async function onLogo(e) {
    const file = e.target.files?.[0]; e.target.value = ''; setMsg(null); setErr(null);
    if (!file) return;
    const chk = checkLogo({ type: file.type, size: file.size }); if (chk.error) return setErr(chk.error);
    const t = await token(); const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/billing/logo', { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : { error: 'Network problem. Try again.' };
    if (!r?.ok) return setErr(j.error || 'Couldn’t upload the logo.');
    setMsg('Logo saved. It shows at the top of your invoices.'); load();
  }
  async function removeLogo() { const j = await api('/api/billing/logo', { method: 'DELETE' }); if (j.error) { setErr(j.error); return false; } load(); return true; }
  async function remove(kind, id) { const j = await api(`/api/billing/${kind}/${id}`, { method: 'DELETE' }); if (j.error) { setErr(j.error); return false; } load(); return true; }
  const done = () => { setEdit(null); load(); };

  const list = (kind, items, line) => (
    <>
      {items.length === 0 && <p style={s.muted}>None yet.</p>}
      {items.map((it) => edit?.kind === kind && edit.item?.id === it.id ? <EntityForm key={it.id} kind={kind} initial={it} onCancel={() => setEdit(null)} onSaved={done} /> : (
        <div key={it.id} style={s.row} data-testid={`${kind}-row`}>
          <div style={{ fontWeight: 600 }}>{it.name}</div>
          <div style={s.muted}>{line(it)}</div>
          {!ro && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" style={s.btn} onClick={() => setEdit({ kind, item: it })}>Edit</button>
            <ConfirmButton label="Delete" prompt={`Delete ${it.name}? Invoices already made keep their copy of the details.`} onConfirm={() => remove(kind, it.id)} />
          </div>}
        </div>
      ))}
      {!ro && (edit?.kind === kind && !edit.item ? <EntityForm kind={kind} initial={null} onCancel={() => setEdit(null)} onSaved={done} />
        : <button type="button" style={{ ...s.btn, marginTop: '0.6rem' }} onClick={() => setEdit({ kind, item: null })}>+ Add {kind === 'brokers' ? 'broker' : 'factoring company'}</button>)}
    </>
  );

  return (
    <section style={s.card} data-testid="company-billing">
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Billing</h2>
      <p style={{ ...s.muted, marginTop: 4 }}>Used on your invoices. {ro && 'Only the owner or Management can change these.'}</p>
      <form onSubmit={saveSettings}>
        <p style={{ margin: '0.5rem 0 0' }}>Next invoice number: <strong data-testid="next-invoice-number">{st.settings.invoice_prefix}{st.settings.invoice_next_number}</strong> <span style={s.muted}>(given when you finalize an invoice)</span></p>
        <Field label="Default payment terms (days)"><input style={s.input} inputMode="numeric" disabled={ro} value={form.default_terms_days} onChange={(e) => setForm({ ...form, default_terms_days: e.target.value })} /></Field>
        <p style={{ ...s.muted, margin: '4px 0 0' }}>{/^\d+$/.test(form.default_terms_days) ? termsLabel(form.default_terms_days) : ''} unless a broker has its own terms.</p>
        <Field label="Default factoring company (new loads are factored when one is set)">
          <select style={s.input} disabled={ro} value={form.default_factor_id} onChange={(e) => setForm({ ...form, default_factor_id: e.target.value })}>
            <option value="">None (I bill brokers directly)</option>
            {st.factors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label="Remit-to on invoices that aren’t factored (blank = company address)"><textarea style={{ ...s.input, minHeight: 64, padding: 10 }} disabled={ro} value={form.remit_to} onChange={(e) => setForm({ ...form, remit_to: e.target.value })} /></Field>
        {!ro && <button type="submit" style={{ ...s.primary, marginTop: '0.75rem' }}>Save billing settings</button>}
      </form>

      <h3 style={s.h3}>Logo (optional)</h3>
      {logoUrl ? <img src={logoUrl} alt="Company logo" style={{ maxHeight: 64, maxWidth: 220, display: 'block', margin: '0.5rem 0' }} /> : <p style={s.muted}>No logo. Invoices show your company name.</p>}
      {!ro && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ ...s.btn, display: 'inline-flex', alignItems: 'center' }}>{logoUrl ? 'Replace logo' : 'Upload logo'}<input type="file" accept="image/png,image/jpeg" onChange={onLogo} style={{ display: 'none' }} /></label>
        {logoUrl && <ConfirmButton label="Remove logo" prompt="Remove the logo from your invoices?" onConfirm={removeLogo} />}
      </div>}

      <h3 style={s.h3}>Brokers</h3>
      {list('brokers', st.brokers, (b) => [b.billing_emails?.join(', ') || 'No billing email', termsLabel(b.terms_days ?? st.settings.default_terms_days), b.noa_on_file ? 'NOA on file' : null].filter(Boolean).join(' · '))}

      <h3 style={s.h3}>Factoring companies</h3>
      {list('factors', st.factors, (f) => [f.submission_email || f.portal_url || 'No submission email', PACKET_FORMATS.find((p) => p.id === f.packet_format)?.label, st.settings.default_factor_id === f.id ? 'Default' : null].filter(Boolean).join(' · '))}
      {st.settings.default_factor_id && <p style={{ ...s.muted, marginTop: 8 }}>Default: {factorName(st.settings.default_factor_id)}</p>}

      {msg && <p role="status" style={{ marginTop: '0.75rem' }}>{msg}</p>}
      {err && <p role="alert" style={s.err}>{err}</p>}
    </section>
  );
}
