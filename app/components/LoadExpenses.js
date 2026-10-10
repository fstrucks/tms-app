'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';
import { fmtMoney } from '../lib/loads';
import { sumAmounts } from '../lib/expenses';

// Expense total and net (rate - expenses) for one load. Self-contained so the load page needs one line.
export default function LoadExpenses({ loadId, rate }) {
  const supabase = getSupabase();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!supabase || !loadId) return;
    let cancelled = false;
    supabase.from('expenses').select('id, amount').eq('load_id', loadId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) { console.error('[LoadExpenses]', error); setError('Could not load expenses.'); }
      else setRows(data || []);
    });
    return () => { cancelled = true; };
  }, [loadId]);

  const total = sumAmounts(rows);
  const hasRate = rate != null && rate !== '';
  const net = hasRate ? Number(rate) - total : null;
  const card = { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' };
  const row = { display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0', fontSize: '0.9rem' };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Expenses</h2>
        <Link href={`/expenses?load=${loadId}`} style={{ color: '#2563eb', fontSize: '0.9rem' }}>Add / view</Link>
      </div>
      {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : rows === null ? <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>Loading…</p> : (
        <>
          <div style={row}><span style={{ color: '#6b7280' }}>Expenses ({rows.length})</span><span>{fmtMoney(total)}</span></div>
          <div style={{ ...row, fontWeight: 600, borderTop: '1px solid #f1f5f9' }}>
            <span>Net</span>
            <span style={{ color: net != null && net < 0 ? '#b91c1c' : 'inherit' }}>{net != null ? fmtMoney(net) : '—'}</span>
          </div>
        </>
      )}
    </div>
  );
}
