'use client';
// Invoices list (invoicing PR 3, layout A's list). Office roles only; rows open the load's Invoice tab.
// Tabs show counts; Unpaid includes short-paid, and the unpaid total is the balance still owed (QA #6).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { fmtMoney } from '../lib/money';
import { statusLabel, localDate } from '../lib/invoice';
import { LIST_TABS, inTab, balanceDue } from '../lib/invoiceBundle';

const { call: api } = makeApi(() => getSupabase()?.auth);
const today = () => localDate();

export default function InvoicesPage() {
  const [tab, setTab] = useState('all');
  const [st, setSt] = useState({ loading: true });
  useEffect(() => { api('/api/invoices').then((j) => setSt(j.error ? { error: j.error, setupNeeded: j.setupNeeded } : j)); }, []);
  const rows = (st.invoices || []).filter((i) => inTab(i, tab));
  return (
    <main style={{ padding: '1rem', fontFamily: 'system-ui', maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem' }}>Invoices</h1>
      {!st.loading && !st.error && <p data-testid="invoices-unpaid" style={{ margin: '0 0 0.75rem' }}>Unpaid: <strong>{fmtMoney(st.unpaidTotal || 0)}</strong> <span style={{ color: 'var(--text-muted)' }}>({st.counts?.unpaid || 0} invoice{st.counts?.unpaid === 1 ? '' : 's'}, incl. short-paid balances)</span></p>}
      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        {LIST_TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`invoices-tab-${k}`}
          style={{ minHeight: 40, padding: '0 14px', borderRadius: 999, border: '1px solid var(--border)', background: tab === k ? 'var(--primary)' : 'var(--surface)', color: tab === k ? 'var(--on-primary)' : 'var(--text)', fontWeight: 600 }}>{label}{st.counts ? ` (${st.counts[k] ?? 0})` : ''}</button>)}
      </div>
      {st.error ? <p role="alert" style={{ color: st.setupNeeded ? 'var(--text-muted)' : 'var(--danger)' }}>{st.error}</p>
        : st.loading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        : rows.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>No invoices here yet. A draft is made when a load is marked delivered.</p>
        : <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }} data-testid="invoices-table">
              <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>{['Invoice', 'Load', 'Bill to', 'Total', 'Balance', 'Due', 'Status'].map((h) => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--divider)' }}>{h}</th>)}</tr></thead>
              <tbody>{rows.map((i) => {
                const open = inTab(i, 'unpaid');
                const overdue = open && i.due_date && i.due_date < today();
                return (
                  <tr key={i.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                    <td style={{ padding: '8px' }}>{i.load_id ? <Link href={`/loads/${i.load_id}?tab=invoice`} style={{ color: 'var(--primary)', fontWeight: 600 }}>{i.invoice_number || 'Draft'}</Link> : (i.invoice_number || 'Draft')}</td>
                    <td style={{ padding: '8px' }}>{i.load_ref?.load_number || '—'}</td>
                    <td style={{ padding: '8px' }}>{i.bill_to?.name || '—'}{i.factored ? <span style={{ color: 'var(--text-muted)' }}> · factored</span> : null}</td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{fmtMoney(i.total)}</td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{open ? fmtMoney(balanceDue(i)) : '—'}</td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap', color: overdue ? 'var(--danger)' : undefined }}>{i.due_date || '—'}{overdue ? ' (overdue)' : ''}</td>
                    <td style={{ padding: '8px' }}>{statusLabel(i.status)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>}
    </main>
  );
}
