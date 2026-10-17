'use client';
// Load page: scale tickets linked to this load, with net cargo and over-weight warnings (same helper as /truck,
// computed on the server). View only here; tickets are added and confirmed on the Truck tab (drivers can't edit).
import { useEffect, useState } from 'react';
import Link from 'next/link';

const lb = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-US')} lb`);
const mdy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '—');

export default function LoadScaleTickets({ supabase, loadId, loadWeight, cardStyle }) {
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    (async () => {
      const t = (await supabase.auth.getSession())?.data?.session?.access_token;
      try {
        const res = await fetch(`/api/loads/${loadId}/scale-tickets`, { cache: 'no-store', headers: { Authorization: `Bearer ${t || ''}` } });
        const j = await res.json().catch(() => ({}));
        if (live) setSt(res.ok ? { state: 'ready', ...j } : { state: 'error', error: j.error || 'Couldn’t load scale tickets.' });
      } catch { if (live) setSt({ state: 'error', error: 'Couldn’t load scale tickets.' }); }
    })();
    return () => { live = false; };
  }, [loadId, loadWeight]); // eslint-disable-line react-hooks/exhaustive-deps

  if (st.state === 'loading' || st.setupNeeded) return null;
  return (
    <div style={cardStyle} data-testid="load-scale-tickets">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.5rem' }}>Scale tickets</h2>
        <Link href="/truck" style={{ color: '#2563eb', fontSize: 14 }}>{st.canEdit ? 'Add on Truck tab' : 'Truck tab'}</Link>
      </div>
      {st.state === 'error' ? <p style={{ color: '#b91c1c', fontSize: 14 }}>{st.error}</p>
        : !st.tickets.length ? <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>No scale tickets linked to this load.</p>
        : (<>
          {st.loadWeight == null && <p style={{ color: '#92400e', fontSize: 13, margin: '0 0 0.5rem' }}>Add the load weight to compare with the rate con.</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {st.tickets.map((t) => (
              <li key={t.id} data-testid="load-ticket-row" style={{ borderTop: '1px solid #f1f5f9', padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>{mdy(t.ticket_date)}{t.truck_number ? ` · Truck #${t.truck_number}` : ''}
                    {!t.confirmed && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block' }}>Not confirmed</span>}</span>
                  <strong style={{ whiteSpace: 'nowrap' }}>{lb(t.gross_weight_lb)}</strong>
                </div>
                <div style={{ color: '#6b7280', fontSize: 13 }}>
                  {[t.net != null ? `Net cargo ${lb(t.net)}` : 'Net cargo needs both empty weights', st.loadWeight != null ? `rate con ${lb(st.loadWeight)}` : null, t.scale_name].filter(Boolean).join(' · ')}
                </div>
                {t.warnings?.length > 0 && (
                  <ul data-testid="load-ticket-warnings" style={{ margin: '6px 0 0', paddingLeft: '1.1rem', color: '#b91c1c', fontSize: 14 }}>
                    {t.warnings.map((w) => <li key={w.code} data-code={w.code}>{w.text}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>)}
    </div>
  );
}
