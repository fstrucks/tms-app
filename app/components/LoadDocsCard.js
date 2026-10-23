'use client';
// Documents card for a load outside the load page (Dispatch → load). Same data and rules as the load page's
// Documents section: /api/loads/:id/documents (team uploads + Truck-tab scale ticket photos), scan to this load.
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import LoadDocThumb from './LoadDocThumb';
import { fetchLoadDocs } from '../lib/loadDocsClient';
import { uploadScan } from '../lib/scanUpload';
import { docTypeLabel, LOAD_SCAN_TYPE_IDS } from '../lib/docTypes';

const Scanner = dynamic(() => import('./scanner/Scanner'), { ssr: false, loading: () => null });
const btn = { minHeight: 44, padding: '0 12px', borderRadius: 8, border: '1px solid var(--primary)', background: 'var(--surface)', color: 'var(--primary)', fontWeight: 600 };

export default function LoadDocsCard({ supabase, loadId, loadLabel, userId, cardStyle }) {
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false); // re-fetch in flight (e.g. after a delete): "Loading…", not "No linked documents"
  async function refresh() {
    setBusy(true);
    const { data, error } = await fetchLoadDocs(supabase, loadId).finally(() => setBusy(false));
    if (error) { setErr("Couldn't load this load's documents."); return; }
    setErr(null); setDocs(data || []);
  }
  useEffect(() => { refresh(); }, [loadId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={cardStyle} data-testid="load-docs-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Documents</h2>
        <button type="button" onClick={() => { setMsg(null); setScanning(true); }} style={btn}>🧾 Scan document</button>
      </div>
      {msg && <p role="status" style={{ color: 'var(--success)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>{msg}</p>}
      {err ? <p role="alert" style={{ color: 'var(--danger)', fontSize: 14 }}>{err}</p>
        : docs === null || (busy && docs.length === 0) ? <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading documents…</p>
        : docs.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>No linked documents.</p>
        : docs.map((d) => (
          <div key={d.id} data-testid="load-doc-row" data-doc-type={d.doc_type} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid var(--divider)' }}>
            <LoadDocThumb doc={d} onOpen={() => d.url && window.open(d.url, '_blank', 'noopener')} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}><strong style={{ color: 'var(--text)' }}>{d.label || docTypeLabel(d.doc_type)}</strong> · {new Date(d.created_at).toLocaleDateString()}</div>
            </div>
            {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>View</a>}
          </div>
        ))}
      {scanning && (
        <Scanner loads={[{ id: loadId, label: loadLabel || 'This load' }]} initialLoadId={loadId} typeIds={LOAD_SCAN_TYPE_IDS}
          onClose={() => setScanning(false)}
          onSave={async (scan) => {
            const e = await uploadScan(supabase, userId, scan);
            if (e && !e.saved) return e;
            setScanning(false); setMsg(e?.warning || `Saved ${scan.file.name}.`);
            await refresh();
            return null;
          }} />
      )}
    </div>
  );
}
