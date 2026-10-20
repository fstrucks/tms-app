'use client';
// Load page: scale tickets linked to this load, with net cargo and over-weight warnings (same helper as /truck,
// computed on the server). View only here; tickets are added and confirmed on the Truck tab (drivers can't edit).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadScaleTickets } from '../lib/scaleTicketsLoad';
import LoadDocThumb from './LoadDocThumb';

const lb = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-US')} lb`);
const mdy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '—');

export default function LoadScaleTickets({ supabase, loadId, loadWeight, cardStyle }) {
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    loadScaleTickets(supabase, loadId).then((r) => { if (live) setSt(r); });
    return () => { live = false; };
  }, [loadId, loadWeight]); // eslint-disable-line react-hooks/exhaustive-deps

  if (st.state === 'loading' || st.setupNeeded) return null;
  return (
    <div style={cardStyle} data-testid="load-scale-tickets">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.5rem' }}>Scale tickets</h2>
        <Link href="/truck" style={{ color: 'var(--primary)', fontSize: 14 }}>{st.canEdit ? 'Add on Truck tab' : 'Truck tab'}</Link>
      </div>
      {st.state === 'error' ? <p style={{ color: 'var(--danger)', fontSize: 14 }}>{st.error}</p>
        : !st.tickets.length && !st.ticketDocs?.length ? <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>No scale tickets linked to this load.</p>
        : (<>
          {/* PR #110: scale-ticket documents (Documents tab / load-page scan) with no weight entered on the Truck tab yet. */}
          {st.ticketDocs?.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {st.ticketDocs.map((d) => (
                <li key={d.id} data-testid="load-ticket-doc-row" style={{ borderTop: '1px solid var(--divider)', padding: '8px 0', display: 'flex', gap: 10, alignItems: 'center' }}>
                  <LoadDocThumb doc={{ ...d, label: 'Scale ticket' }} onOpen={() => d.url && window.open(d.url, '_blank', 'noopener')} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div>{mdy(d.doc_date || d.created_at?.slice(0, 10))} · Scale ticket</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename} · weight not entered{st.canEdit ? ' (add it on the Truck tab)' : ''}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {st.tickets.length > 0 && st.loadWeight == null && <p style={{ color: 'var(--warning)', fontSize: 13, margin: '0 0 0.5rem' }}>Add the load weight to compare with the rate con.</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {st.tickets.map((t) => (
              <li key={t.id} data-testid="load-ticket-row" style={{ borderTop: '1px solid var(--divider)', padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>{mdy(t.ticket_date)}{t.truck_number ? ` · Truck #${t.truck_number}` : ''}
                    {!t.confirmed && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block' }}>Not confirmed</span>}</span>
                  <strong style={{ whiteSpace: 'nowrap' }}>{lb(t.gross_weight_lb)}</strong>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {[t.net != null ? `Net cargo ${lb(t.net)}` : 'Net cargo needs both empty weights', st.loadWeight != null ? `rate con ${lb(st.loadWeight)}` : null, t.scale_name].filter(Boolean).join(' · ')}
                </div>
                {t.warnings?.length > 0 && (
                  <ul data-testid="load-ticket-warnings" style={{ margin: '6px 0 0', paddingLeft: '1.1rem', color: 'var(--danger)', fontSize: 14 }}>
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
