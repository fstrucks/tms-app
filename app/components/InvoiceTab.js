'use client';
// Load page → Invoice tab (invoicing PR 2, layout A). Owner + Management edit the draft and finalize it; Dispatchers
// see it read-only; drivers never get here (the server answers 403 and the tab is hidden).
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import ConfirmButton from './ui/ConfirmButton';
import InvoiceBundle from './InvoiceBundle';
import { fmtMoney } from '../lib/money';
import { EXTRA_TYPES, lineLabel, statusLabel, termsLabel, totalOf, cleanLines } from '../lib/invoice';

const { call: api, token } = makeApi(() => getSupabase()?.auth);
const s = {
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  btn: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' },
  primary: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, cursor: 'pointer' },
  input: { minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', boxSizing: 'border-box' },
  row: { display: 'flex', gap: 8, alignItems: 'center', padding: '0.4rem 0', borderBottom: '1px solid var(--divider)' },
  err: { color: 'var(--danger)', fontSize: 14, margin: '0.5rem 0 0' },
  badge: { display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: 'var(--surface-2, var(--warning-bg))', fontWeight: 600, fontSize: 13 },
};
const toForm = (j) => ({
  lines: (j.invoice?.line_items || []).map((l) => ({ type: l.type, amount: Number(l.amount).toFixed(2), note: l.note || '' })),
  notes: j.invoice?.notes || '', terms_days: String(j.invoice?.terms_days ?? j.settings?.default_terms_days ?? 30),
  broker_id: j.load?.broker_id || j.matchedBrokerId || '', factored: j.invoice ? !!j.invoice.factored : !!j.settings?.default_factor_id,
});

export async function openInvoicePdf(invoiceId, { print = false } = {}) {
  const t = await token();
  const r = await fetch(`/api/invoices/${invoiceId}/pdf`, { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return 'Couldn’t open the PDF. Please try again.';
  const url = URL.createObjectURL(await r.blob());
  const w = window.open(url, '_blank', 'noopener');
  if (print && w) setTimeout(() => { try { w.print(); } catch { /* the viewer has its own Print button */ } }, 800);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return null;
}

export default function InvoiceTab({ loadId, onLoadStatus, onHidden, children }) {
  const [st, setSt] = useState({ loading: true });
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  const cb = useRef({}); cb.current = { onLoadStatus, onHidden }; // parent passes new arrows each render
  const apply = useCallback((j) => { setSt(j); setForm(toForm(j)); setDirty(false); if (j.load?.status) cb.current.onLoadStatus?.(j.load.status); }, []);
  const load = useCallback(async () => {
    const j = await api(`/api/loads/${loadId}/invoice`);
    if (j.status === 403) { cb.current.onHidden?.(); return setSt({ hidden: true }); }
    if (j.error) return setSt({ error: j.error, setupNeeded: j.setupNeeded });
    apply(j);
  }, [loadId, apply]);
  useEffect(() => { load(); }, [load]);

  if (st.hidden) return null;
  if (st.loading) return <div style={s.card}><p style={s.muted}>Loading invoice…</p></div>;
  if (st.error) return <div style={s.card}><p role="alert" style={st.setupNeeded ? s.muted : s.err}>{st.error}</p></div>;

  const inv = st.invoice;
  const draft = !inv || inv.status === 'draft';
  const ro = !st.canEdit || !draft;
  const factor = st.factors.find((f) => f.id === st.settings?.default_factor_id);
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); setMsg(null); };
  const setLine = (i, patch) => set({ lines: form.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const liveTotal = totalOf(form.lines.map((l) => ({ amount: Number(String(l.amount).replace(/[$,\s]/g, '')) || 0 })));

  async function save() {
    setErr(null); setMsg(null);
    const c = cleanLines(form.lines); if (c.error) { setErr(c.error); return null; }
    setBusy(true);
    const j = await api(`/api/loads/${loadId}/invoice`, { method: 'PATCH', body: JSON.stringify({ line_items: form.lines, notes: form.notes, terms_days: form.terms_days, broker_id: form.broker_id || null, factored: form.factored }) });
    setBusy(false);
    if (j.error) { setErr(j.error); return null; }
    apply(j); setMsg('Draft saved.');
    return j;
  }
  async function finalize() {
    if (dirty && !(await save())) return false;
    setBusy(true); setErr(null);
    const j = await api(`/api/loads/${loadId}/invoice`, { method: 'POST', body: JSON.stringify({ action: 'finalize' }) });
    setBusy(false);
    if (j.error) { setErr(j.error); return false; }
    apply(j); setMsg(`Finalized as ${j.invoice.invoice_number}. The load is now Invoiced.`);
    return true;
  }
  async function pdf(print) { setErr(null); const e = await openInvoicePdf(inv.id, { print }); if (e) setErr(e); }

  return (
    <div data-testid="invoice-tab">
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Invoice {inv?.invoice_number ? <span data-testid="invoice-number">{inv.invoice_number}</span> : ''}</h2>
          <span style={s.badge} data-testid="invoice-status">{inv ? statusLabel(inv.status) : 'Not started'}</span>
        </div>
        {!inv && <p style={s.muted}>{st.canEdit ? 'A draft is made automatically when the load is marked delivered. You can also start it now.' : 'No invoice yet. The owner or Management can start one.'}</p>}
        {inv?.auto_drafted && draft && <p style={s.muted}>Started automatically when the load was delivered. Check the charges, then finalize.</p>}
        {!st.hasProfile && <p role="alert" style={s.err}>Fill in your company profile first (Account menu → Company).</p>}

        <label style={{ display: 'block', marginTop: '0.6rem' }}><span style={s.muted}>Bill to</span>
          <select style={{ ...s.input, display: 'block', width: '100%' }} disabled={ro} value={form.broker_id} onChange={(e) => set({ broker_id: e.target.value })} data-testid="invoice-broker">
            <option value="">{st.load.broker_name ? `${st.load.broker_name} (not saved in Billing)` : 'Pick a broker'}</option>
            {st.brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        {!form.broker_id && <p style={s.muted}>Save this broker in Company → Billing to keep its billing email and terms.</p>}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginTop: '0.4rem' }}>
          <input type="checkbox" data-testid="invoice-factored" disabled={ro || !factor} checked={!!form.factored} onChange={(e) => set({ factored: e.target.checked })} style={{ width: 22, height: 22 }} />
          <span>{factor ? `Factored: payment goes to ${factor.name}` : 'Factored (set a factoring company in Company → Billing first)'}</span>
        </label>

        <label style={{ display: 'block', marginTop: '0.4rem' }}><span style={s.muted}>Payment terms (days) </span>
          <input style={{ ...s.input, width: 90 }} inputMode="numeric" disabled={ro} value={form.terms_days} onChange={(e) => set({ terms_days: e.target.value })} />
          <span style={s.muted}> {/^\d+$/.test(form.terms_days) ? termsLabel(form.terms_days) : ''}</span>
        </label>
      </div>

      <div style={s.card}>
        <h3 style={{ fontSize: '1rem', margin: 0 }}>Charges</h3>
        {form.lines.length === 0 && <p style={s.muted}>No charges yet. This load has no rate; add the linehaul.</p>}
        {form.lines.map((l, i) => (
          <div key={i} style={{ ...s.row, flexWrap: 'wrap' }} data-testid="invoice-line">
            <span style={{ flex: '1 1 150px', fontWeight: l.type === 'linehaul' ? 600 : 400 }}>{lineLabel(l.type)}</span>
            {ro ? <span style={{ flex: '1 1 120px', ...s.muted }}>{l.note}</span>
              : <input aria-label={`${lineLabel(l.type)} note`} placeholder="Note (optional)" style={{ ...s.input, flex: '1 1 140px' }} value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} />}
            {ro ? <strong style={{ minWidth: 100, textAlign: 'right' }}>{fmtMoney(l.amount)}</strong>
              : <input aria-label={`${lineLabel(l.type)} amount`} inputMode="decimal" style={{ ...s.input, width: 110, textAlign: 'right' }} value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />}
            {!ro && <button type="button" aria-label={`Remove ${lineLabel(l.type)}`} style={s.btn} onClick={() => set({ lines: form.lines.filter((_, k) => k !== i) })}>✕</button>}
          </div>
        ))}
        {!ro && (
          <select aria-label="Add a charge" style={{ ...s.input, marginTop: '0.6rem' }} value="" onChange={(e) => { if (e.target.value) set({ lines: [...form.lines, { type: e.target.value, amount: '', note: '' }] }); }} data-testid="invoice-add-charge">
            <option value="">+ Add a charge…</option>
            {!form.lines.some((l) => l.type === 'linehaul') && <option value="linehaul">Linehaul</option>}
            {EXTRA_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem', fontSize: '1.1rem' }}>
          <strong>Total due</strong><strong data-testid="invoice-total">{fmtMoney(ro ? inv?.total : liveTotal)}</strong>
        </div>
        <label style={{ display: 'block', marginTop: '0.6rem' }}><span style={s.muted}>Notes on the invoice (optional)</span>
          {ro ? <p style={{ margin: '0.25rem 0 0' }}>{inv?.notes || '—'}</p>
            : <textarea style={{ ...s.input, display: 'block', width: '100%', minHeight: 60, padding: 10 }} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />}
        </label>
        {inv?.invoice_date && <p style={s.muted}>Invoice date {inv.invoice_date} · Due {inv.due_date} ({termsLabel(inv.terms_days)})</p>}
      </div>

      <div style={{ ...s.card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {st.canEdit && draft && <button type="button" style={s.btn} disabled={busy} onClick={save}>{busy ? 'Saving…' : inv ? 'Save draft' : 'Start invoice'}</button>}
        {inv && <button type="button" style={s.btn} onClick={() => pdf(false)} disabled={dirty} title={dirty ? 'Save first' : undefined}>{draft ? 'Preview PDF' : 'Open PDF'}</button>}
        {inv && !draft && <button type="button" style={s.btn} onClick={() => pdf(true)}>Print</button>}
        {st.canEdit && draft && inv && <ConfirmButton label={`Finalize as ${st.settings.invoice_prefix}${st.settings.invoice_next_number}`} confirmLabel="Yes, finalize" danger={false}
          prompt="Finalize? The invoice gets its number and the charges are locked." onConfirm={finalize} disabled={busy} />}
        {children}
      </div>
      {msg && <p role="status" style={{ color: 'var(--success)', margin: '0 0 0.5rem' }}>{msg}</p>}
      {err && <p role="alert" style={s.err}>{err}</p>}
      {inv && !draft && <InvoiceBundle invoiceId={inv.id} onChanged={(next) => { if (next?.status === 'void') load(); else if (next) setSt((x) => ({ ...x, invoice: next })); if (next?.status === 'paid' || next?.status === 'short_paid') cb.current.onLoadStatus?.('paid'); }} />}
      {st.voidedCount > 0 && <p style={s.muted}>{st.voidedCount} voided invoice{st.voidedCount === 1 ? '' : 's'} for this load (see Invoices).</p>}
    </div>
  );
}
