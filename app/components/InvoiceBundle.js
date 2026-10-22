'use client';
// Invoice tab → "Send" card for a finalized invoice (invoicing PR 3). v1 emails nothing: download the packet (one PDF or
// separate files), print, copy the email text, then "Mark as sent". Also Mark paid / short-paid and Void.
import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import ConfirmButton from './ui/ConfirmButton';
import { fmtMoney } from '../lib/money';
import { fmtSize } from '../lib/companyDocs';
import { loadStatusNote } from '../lib/invoice';

const { call: api, token } = makeApi(() => getSupabase()?.auth);
const s = {
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  btn: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' },
  primary: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, cursor: 'pointer' },
  input: { minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', boxSizing: 'border-box', width: '100%' },
  err: { color: 'var(--danger)', fontSize: 14, margin: '0.5rem 0 0' },
};

async function download(invoiceId, which, name) {
  const t = await token();
  const r = await fetch(`/api/invoices/${invoiceId}/bundle?download=${encodeURIComponent(which)}`, { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return 'Couldn’t download that file. Please try again.';
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return null;
}

export default function InvoiceBundle({ invoiceId, onChanged }) {
  const [st, setSt] = useState({ loading: true });
  const [sentTo, setSentTo] = useState('');
  const [paid, setPaid] = useState({ amount: '', date: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const j = await api(`/api/invoices/${invoiceId}/bundle`);
    if (j.error) return setSt({ error: j.error });
    setSt(j); setSentTo((v) => v || j.email?.to || '');
  }, [invoiceId]);
  useEffect(() => { load(); }, [load]);
  if (st.loading) return <div style={s.card}><p style={s.muted}>Loading paperwork…</p></div>;
  if (st.error) return <div style={s.card}><p role="alert" style={s.err}>{st.error}</p></div>;
  const inv = st.invoice;
  const merged = st.format !== 'separate';
  const names = st.files.filter((f) => f.supported !== false).map((f) => f.name);

  async function act(action, body, okText) {
    setErr(null); setMsg(null); setBusy(action);
    const j = await api(`/api/invoices/${invoiceId}`, { method: 'POST', body: JSON.stringify({ action, ...body }) });
    setBusy(null);
    if (j.error) { setErr(j.error); return false; }
    if (okText) setMsg(`${okText}${loadStatusNote(j.loadStatusBefore, j.loadStatus)}`);
    await load(); onChanged?.(j.invoice, j);
    return true;
  }
  async function get(which, name) {
    setErr(null); setBusy(which);
    const e = await download(invoiceId, which, name);
    setBusy(null);
    if (e) return setErr(e);
    act('log', { kind: 'download', files: which === 'merged' ? names : [name] });
  }
  async function copy() {
    const text = `${st.email.to ? `To: ${st.email.to}\n` : ''}Subject: ${st.email.subject}\n\n${st.email.body}`;
    try { await navigator.clipboard.writeText(text); setMsg('Email text copied. Paste it into your email or the factor’s portal.'); } catch { setErr('Couldn’t copy. Select the text below and copy it.'); }
  }

  return (
    <div data-testid="invoice-bundle">
      <div style={s.card}>
        <h3 style={{ fontSize: '1rem', margin: 0 }}>Paperwork to send</h3>
        <p style={s.muted}>{inv.factored ? 'Factored: send to your factoring company.' : 'Send to the broker’s billing email.'} {st.email.to ? <>To: <strong>{st.email.to}</strong></> : 'No email saved yet (add it in Company → Billing).'}</p>
        {st.checks.length > 0 && <ul style={{ margin: '0.5rem 0', paddingLeft: '1.2rem' }} data-testid="bundle-checks">
          {st.checks.map((c, i) => <li key={i} style={{ color: c.level === 'bad' ? 'var(--danger)' : 'var(--warning)', fontSize: 14 }}>{c.text}</li>)}
        </ul>}
        <ol style={{ margin: '0.5rem 0', paddingLeft: '1.2rem' }} data-testid="bundle-files">
          {st.files.map((f) => (
            <li key={f.name} style={{ fontSize: 14, padding: '2px 0', opacity: f.supported === false ? 0.5 : 1 }}>
              {merged || f.supported === false ? f.name : <button type="button" style={{ ...s.btn, minHeight: 36 }} onClick={() => get(f.docId || 'invoice', f.name)} disabled={!!busy}>⬇ {f.name}</button>}
              {f.size ? <span style={s.muted}> · {fmtSize(f.size)}</span> : null}{f.supported === false ? <span style={s.muted}> (left out: not a PDF or photo)</span> : null}
            </li>
          ))}
        </ol>
        {!st.size.ok && <p style={{ color: 'var(--warning)', fontSize: 14 }}>{st.size.text}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={merged ? s.primary : s.btn} disabled={!!busy} onClick={() => get('merged', st.files[0].name.replace(/_Invoice\.pdf$/, '_Packet.pdf'))}>{busy === 'merged' ? 'Building…' : '⬇ Download packet (one PDF)'}</button>
          <button type="button" style={s.btn} onClick={copy}>Copy email text</button>
        </div>
        <details style={{ marginTop: '0.6rem' }}><summary style={{ cursor: 'pointer', minHeight: 32 }}>Show email text</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: 'var(--surface-2, var(--surface))', padding: 8, borderRadius: 8 }} data-testid="bundle-email">{`${st.email.to ? `To: ${st.email.to}\n` : ''}Subject: ${st.email.subject}\n\n${st.email.body}`}</pre>
        </details>
      </div>

      {st.canEdit && inv.status !== 'void' && (
        <div style={s.card}>
          <h3 style={{ fontSize: '1rem', margin: 0 }}>After you send it</h3>
          {inv.sent_at && <p style={s.muted}>Marked as sent {new Date(inv.sent_at).toLocaleString()} to {inv.sent_to}.</p>}
          {!['paid', 'short_paid'].includes(inv.status) && <>
            <label style={{ display: 'block', marginTop: '0.5rem' }}><span style={s.muted}>Sent to (email or portal)</span>
              <input style={s.input} value={sentTo} onChange={(e) => setSentTo(e.target.value)} placeholder="ap@example.com" /></label>
            <button type="button" style={{ ...s.primary, marginTop: 8 }} disabled={!!busy} onClick={() => act('mark_sent', { sent_to: sentTo, files: names }, 'Marked as sent.')}>{inv.sent_at ? 'Mark as sent again' : 'Mark as sent'}</button>
          </>}
          {['ready', 'sent'].includes(inv.status) && <div style={{ marginTop: '0.9rem' }}>
            <span style={s.muted}>Payment received (blank = full {fmtMoney(inv.total)})</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <input aria-label="Amount received" inputMode="decimal" style={{ ...s.input, width: 140 }} value={paid.amount} onChange={(e) => setPaid({ ...paid, amount: e.target.value })} placeholder={Number(inv.total).toFixed(2)} />
              <input aria-label="Date received" type="date" style={{ ...s.input, width: 170 }} value={paid.date} onChange={(e) => setPaid({ ...paid, date: e.target.value })} />
              <ConfirmButton label="Mark paid" confirmLabel="Yes, mark paid" danger={false} prompt="Mark this invoice paid? An open load is marked Paid too." onConfirm={() => act('paid', { paid_amount: paid.amount, paid_at: paid.date }, 'Payment recorded.')} />
            </div>
          </div>}
          {['paid', 'short_paid'].includes(inv.status) && <p style={{ margin: '0.5rem 0 0' }}>{inv.status === 'paid' ? 'Paid' : 'Short-paid'}: {fmtMoney(inv.paid_amount)} on {inv.paid_at}</p>}
          {['ready', 'sent', 'short_paid'].includes(inv.status) && <div style={{ marginTop: '0.9rem' }}>
            <span style={s.muted}>Void (e.g. wrong charges). The number is kept and you can start a new draft.</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <input aria-label="Reason" style={{ ...s.input, flex: '1 1 200px', width: 'auto' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" />
              <ConfirmButton label="Void invoice" confirmLabel="Yes, void" prompt="Void this invoice? This can’t be undone." onConfirm={() => act('void', { reason }, 'Invoice voided.')} />
            </div>
          </div>}
        </div>
      )}
      {msg && <p role="status" style={{ color: 'var(--success)', margin: '0 0 0.5rem' }}>{msg}</p>}
      {err && <p role="alert" style={s.err}>{err}</p>}
    </div>
  );
}
