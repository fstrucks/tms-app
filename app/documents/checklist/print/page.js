'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSetup } from '../useSetup';
import { buildChecklist, modelFromPayload, binderLines } from '../../../lib/setupProgress';

const sheet = { maxWidth: 760, margin: '0 auto', padding: '1rem', fontFamily: 'system-ui', color: 'var(--text)' };

export default function PrintBinderPage() {
  const { data, loading } = useSetup();
  const [truckId, setTruckId] = useState('');
  useEffect(() => { setTruckId(new URLSearchParams(window.location.search).get('truck') || ''); }, []);

  const today = data?.today;
  const ctx = useMemo(() => (data?.profile && today ? modelFromPayload(data, today) : null), [data, today]);
  const rows = useMemo(() => (ctx ? buildChecklist(ctx) : []), [ctx]);
  const trucks = data?.trucks || [];
  const truck = trucks.find((t) => t.id === truckId) || trucks[0] || null;
  const office = !!data?.office;
  const lines = truck && ctx ? binderLines(truck, ctx, rows) : [];
  const gear = rows.filter((r) => r.category === 'equipment' && truck && r.truckId === truck.id && r.applicable);

  return (
    <main className="print-sheet" style={sheet}>
      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" onClick={() => window.print()} style={{ minHeight: 44, padding: '0 0.9rem', border: 'none', borderRadius: 8, background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700 }}>Print</button>
        <Link href="/documents/checklist">Back to checklist</Link>
      </div>
      {loading ? <p>Loading…</p>
        : data?.setupNeeded ? <p>The setup checklist isn’t available yet.</p>
        : !data?.profile ? <p>Sign in and add a company to print this list.</p>
        : !truck ? <p>Add a truck on the Truck tab, then print its binder.</p>
        : (
          <>
            <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>In-cab binder and equipment</h1>
            <p style={{ margin: '0.2rem 0' }}>{data.profile.legal_name || data.profile.dba_name || 'Company'}</p>
            <p style={{ margin: '0.2rem 0' }}>Truck {truck.unit_number || '—'}</p>
            <p style={{ margin: '0.2rem 0 1rem' }}>Date {today}</p>
            <h2 style={{ fontSize: '1.1rem' }}>Binder</h2>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {lines.map((l) => (
                <li key={`${l.displayKey}:${l.itemKey}:${l.trailerId || ''}`} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--divider)' }}>
                  <span aria-hidden="true">{l.done ? '☑' : '☐'}</span> {l.title}
                  {office && l.verified === false ? ' · Not confirmed' : ''}
                </li>
              ))}
            </ul>
            <h2 style={{ fontSize: '1.1rem' }}>Equipment</h2>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {gear.map((r) => (
                <li key={r.itemKey} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--divider)' }}>
                  <span aria-hidden="true">{r.done ? '☑' : '☐'}</span> {r.title}
                  {office && r.verified === false ? ' · Not confirmed' : ''}
                </li>
              ))}
            </ul>
            <p style={{ marginTop: '2rem' }}>Checked by ______________________________ &nbsp; Signature ______________________________</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>General guidance, not legal advice. Check with your state or FMCSA.</p>
          </>
        )}
    </main>
  );
}
