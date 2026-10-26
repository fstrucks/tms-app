'use client';
// Load page → Export screen (delivered or later; owner, management, dispatchers). The user picks what goes in, sees the
// exact list in order, then downloads one PDF. Download only for now; nothing is emailed from here.
import { useEffect, useState } from 'react';
import { showExport, defaultSelection, previewList, selectionQuery, NOTE_MAX } from '../lib/loadExport';

const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.95rem', cursor: 'pointer' };
const row = { display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.92rem', minHeight: 32 };
const muted = { margin: 0, fontSize: '0.88rem', color: 'var(--text-muted)' };

export default function LoadExport({ supabase, load, cardStyle }) {
  const visible = showExport(load);
  const [info, setInfo] = useState(null);
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const token = async () => (await supabase.auth.getSession()).data?.session?.access_token || '';
  useEffect(() => {
    if (!visible || !open || info) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/loads/${load.id}/export`, { cache: 'no-store', headers: { Authorization: `Bearer ${await token()}` } });
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) { setInfo(j); setSel(defaultSelection(j.options)); } else setErr(j.error || 'Couldn’t check this load’s documents.');
      } catch { if (live) setErr('Couldn’t check this load’s documents.'); }
    })();
    return () => { live = false; };
  }, [visible, open, info, load?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;
  const o = info?.options;
  const preview = previewList(o, sel || {});
  const set = (k, v) => setSel((s) => ({ ...s, [k]: v }));
  const toggleDoc = (id, on) => setSel((s) => ({ ...s, docIds: on ? [...s.docIds, id] : s.docIds.filter((x) => x !== id) }));

  async function get() {
    setErr(null); setNote(null); setBusy(true);
    try {
      let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* default */ }
      const r = await fetch(`/api/loads/${load.id}/export?${selectionQuery(sel, tz)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${await token()}` } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Couldn’t build the packet. Please try again.'); }
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'Packet.pdf';
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      const skipped = decodeURIComponent(r.headers.get('x-packet-skipped-names') || '');
      setNote(`Downloaded ${name}.${skipped ? ` Left out because it couldn’t be read: ${skipped}.` : ''}`);
    } catch (e) { setErr(e.message || 'Couldn’t build the packet. Please try again.'); }
    setBusy(false);
  }

  const missing = (o?.missing || []).map((t) => (t === 'pod' ? 'POD' : 'rate confirmation'));
  return (
    <div style={cardStyle} data-testid="load-export">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Export</h2>
      {!open ? (
        <button type="button" style={btn} data-testid="load-export-open" onClick={() => setOpen(true)}>⬇ Export or invoice</button>
      ) : !o || !sel ? (!err && <p style={muted}>Checking documents…</p>) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <p style={muted}>Choose what goes in the PDF.</p>
          <label style={row}><input type="checkbox" data-testid="load-export-invoice" checked={sel.invoice} onChange={(e) => set('invoice', e.target.checked)} />
            Invoice page {info.invoiceNumber ? `(${info.invoiceNumber})` : '(prints as a draft until the invoice is finalized)'}</label>
          {o.docs.map((d) => (
            <label key={d.id} style={{ ...row, opacity: d.supported ? 1 : 0.6 }}>
              <input type="checkbox" data-testid={`load-export-doc-${d.id}`} disabled={!d.supported} checked={d.supported && sel.docIds.includes(d.id)} onChange={(e) => toggleDoc(d.id, e.target.checked)} />
              {d.label}{d.name ? `: ${d.name}` : ''}{!d.supported && ' (can’t be added: only PDF, JPG and PNG files)'}
            </label>
          ))}
          {!o.docs.length && <p style={muted}>No documents on this load yet.</p>}
          {o.stopTimes.available && <label style={row}><input type="checkbox" data-testid="load-export-stoptimes" checked={sel.stopTimes} onChange={(e) => set('stopTimes', e.target.checked)} /> Stop times (arrival and departure for each stop)</label>}
          {o.loadNotes.available && <label style={row}><input type="checkbox" data-testid="load-export-loadnotes" checked={sel.loadNotes} onChange={(e) => set('loadNotes', e.target.checked)} /> Print the load’s notes</label>}
          <label style={{ fontSize: '0.92rem' }}>Note for this packet (optional)
            <textarea data-testid="load-export-note" maxLength={NOTE_MAX} rows={3} value={sel.note} onChange={(e) => set('note', e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 4, borderRadius: 8, border: '1px solid var(--border)', padding: 8, background: 'var(--surface)', color: 'var(--text)' }} />
          </label>
          {!!missing.length && <p data-testid="load-export-missing" style={{ ...muted, color: 'var(--warning, #b45309)' }}>No {missing.join(' or ')} on this load.</p>}
          <div data-testid="load-export-preview" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
            <strong style={{ fontSize: '0.92rem' }}>The PDF will include, in this order:</strong>
            {preview.length ? <ol style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: '0.9rem' }}>{preview.map((p, i) => <li key={i}>{p}</li>)}</ol> : <p style={muted}>Nothing selected yet.</p>}
          </div>
          <div><button type="button" style={btn} disabled={busy || !preview.length} data-testid="load-export-download" onClick={get}>{busy ? 'Building…' : `Download PDF${sel.invoice ? ' with invoice' : ' without invoice'}`}</button></div>
        </div>
      )}
      {note && <p role="status" style={{ color: 'var(--success)', fontSize: '0.9rem', margin: '6px 0 0' }}>{note}</p>}
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
