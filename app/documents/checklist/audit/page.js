'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useSetup } from '../useSetup';
import { buildChecklist, summarize, modelFromPayload } from '../../../lib/setupProgress';
import { CATEGORIES } from '../../../lib/setupCatalog';

const sheet = { maxWidth: 900, margin: '0 auto', padding: '1rem', fontFamily: 'system-ui', color: 'var(--text)' };

function statusOf(row) {
  if (!row.applicable) return 'Not needed';
  if (row.bucket === 'done') return 'Done';
  if (row.bucket === 'expiring') return 'Expiring';
  if (row.bucket === 'expired') return 'Expired';
  if (row.skipped) return 'Skipped';
  return 'Missing';
}

export default function AuditFolderPage() {
  const { data, loading } = useSetup();
  const today = data?.today;
  const ctx = useMemo(() => (data?.profile && today ? modelFromPayload(data, today) : null), [data, today]);
  const rows = useMemo(() => (ctx ? buildChecklist(ctx) : []), [ctx]);
  const progress = summarize(rows);
  const office = !!data?.office;

  return (
    <main className="print-sheet" style={sheet}>
      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" onClick={() => window.print()} style={{ minHeight: 44, padding: '0 0.9rem', border: 'none', borderRadius: 8, background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700 }}>Print / Save as PDF</button>
        <Link href="/documents/checklist">Back to checklist</Link>
      </div>
      {loading ? <p>Loading…</p>
        : data?.setupNeeded ? <p>The setup checklist isn’t available yet.</p>
        : !data?.profile ? <p>Sign in and add a company to open the audit folder.</p>
        : !office ? <p>The audit folder is for the office.</p>
        : (
          <>
            <h1 style={{ fontSize: '1.45rem', marginBottom: 4 }}>Audit folder</h1>
            <p style={{ margin: '0.15rem 0' }}>{data.profile.legal_name || data.profile.dba_name || 'Company'}</p>
            <p style={{ margin: '0.15rem 0' }}>USDOT {data.profile.dot_number || '—'}</p>
            <p style={{ margin: '0.15rem 0' }}>Printed {today}</p>
            <p style={{ margin: '0.15rem 0 1rem' }}><strong>{progress.percent}% complete</strong> · {progress.requiredDone} of {progress.requiredTotal} required</p>
            {CATEGORIES.map((cat) => {
              const mine = rows.filter((r) => r.category === cat.key && (r.applicable || r.bucket === 'not_needed'));
              if (!mine.length) return null;
              return (
                <section key={cat.key} style={{ marginBottom: '1rem' }}>
                  <h2 style={{ fontSize: '1.05rem', margin: '0.6rem 0' }}>{cat.name}</h2>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr>
                        {['Item', 'Status', 'Expiry', 'Uploaded', 'File'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid var(--divider)', padding: '0.3rem' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {mine.map((r) => (
                        <tr key={`${r.itemKey}:${r.truckId || ''}:${r.trailerId || ''}:${r.driverId || ''}`}>
                          <td style={{ padding: '0.3rem', borderBottom: '1px solid var(--divider)' }}>{r.title}{r.unitLabel ? ` · ${r.unitLabel}` : ''}{r.verified === false ? ' · Not confirmed' : ''}</td>
                          <td style={{ padding: '0.3rem', borderBottom: '1px solid var(--divider)' }}>{statusOf(r)}</td>
                          <td style={{ padding: '0.3rem', borderBottom: '1px solid var(--divider)' }}>{r.expiryOn || '—'}</td>
                          <td style={{ padding: '0.3rem', borderBottom: '1px solid var(--divider)' }}>{r.uploadedAt ? String(r.uploadedAt).slice(0, 10) : '—'}</td>
                          <td style={{ padding: '0.3rem', borderBottom: '1px solid var(--divider)' }}>{r.fileName || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })}
            <p style={{ fontSize: 13 }}>General guidance, not legal advice. Check with your state or FMCSA.</p>
          </>
        )}
    </main>
  );
}
