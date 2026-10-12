'use client';

import { useEffect, useRef, useState } from 'react';
import { movePage, removePage, replacePage, fullFrame, buildPdf, scanFileName, PAGE_MAX_WIDTH } from '../../lib/scan';
import { loadPhoto, detect, renderPage, canvasToJpeg, rejectReason } from './imaging';

// Full-screen BOL/POD scanner. Loaded lazily (next/dynamic) only when "Scan document" is used, so
// pdf-lib and the image code never ship with the normal page. Edge detection is a small built-in
// heuristic (no OpenCV). If it finds nothing, the full photo is kept and the user can drag the corners.
//
// TODO(pick 7, open): doc types come from one shared docTypes.js list once Marc decides.
// BOL/POD are used here because the scanner needs them.
const DOC_TYPES = [{ id: 'bol', label: 'BOL' }, { id: 'pod', label: 'POD' }];
const THUMB_W = 320;
const MAX_BYTES = 10 * 1024 * 1024;

const btn = { minHeight: 44, minWidth: 44, padding: '0 0.8rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#111827', fontSize: '0.95rem', cursor: 'pointer' };
const primary = { ...btn, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600 };
let nextId = 1;

export default function Scanner({ initialFiles, loads = [], onClose, onSave }) {
  const [pages, setPages] = useState([]); // { id, source, quad, detected, thumb }
  const [mode, setMode] = useState('bw');
  const [docType, setDocType] = useState('bol');
  const [loadId, setLoadId] = useState('');
  const [busy, setBusy] = useState(null); // text while working
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null); // page index in the corner editor
  const addRef = useRef(null);
  const retakeRef = useRef(null);
  const retakeIdx = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => { addFiles(initialFiles || []); dialogRef.current?.focus(); }, []);
  // Re-render thumbs when B&W/Color changes.
  useEffect(() => { setPages((ps) => ps.map((p) => ({ ...p, thumb: thumbOf(p.source, p.quad, mode) }))); }, [mode]);
  useEffect(() => {
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  function thumbOf(source, quad, m) { return renderPage(source, quad, m, THUMB_W).toDataURL('image/jpeg', 0.6); }

  async function fileToPage(file) {
    const why = rejectReason(file);
    if (why) throw new Error(why);
    const { source, quad, detected } = await loadPhoto(file);
    return { id: nextId++, source, quad, detected, thumb: thumbOf(source, quad, mode) };
  }

  async function addFiles(files, replaceAt = null) {
    if (!files.length) return;
    setMsg(null);
    const added = [];
    for (let i = 0; i < files.length; i++) {
      setBusy(`Processing photo ${i + 1} of ${files.length}…`);
      try { added.push(await fileToPage(files[i])); }
      catch (e) { console.error('[scan] photo', e); setMsg({ err: true, text: `Couldn't read ${files[i].name || 'the photo'}. ${e.message?.endsWith('.') ? e.message : 'Try JPEG or PNG.'}` }); }
    }
    setBusy(null);
    if (!added.length) return;
    let firstUndetected = null;
    setPages((ps) => {
      let out;
      if (replaceAt != null) out = replacePage(ps, replaceAt, added[0]);
      else out = [...ps, ...added];
      const idx = out.findIndex((p) => added.includes(p) && !p.detected);
      firstUndetected = idx >= 0 ? idx : null;
      return out;
    });
    const undetected = added.filter((p) => !p.detected).length;
    if (undetected) setMsg({ text: `Couldn't find the page edges on ${undetected === 1 ? 'one photo' : `${undetected} photos`}. The full photo is kept. Tap "Adjust corners" to crop, or leave it as is.` });
    else setMsg({ text: `${added.length} page${added.length > 1 ? 's' : ''} added.` });
    setTimeout(() => { if (firstUndetected != null) setEditing(firstUndetected); }, 0);
  }

  function updateQuad(i, quad) {
    setPages((ps) => replacePage(ps, i, { ...ps[i], quad, detected: true, thumb: thumbOf(ps[i].source, quad, mode) }));
  }

  async function save() {
    if (!pages.length) return;
    setMsg(null);
    try {
      setBusy('Building PDF…');
      const { PDFDocument } = await import('pdf-lib');
      const out = [];
      for (let i = 0; i < pages.length; i++) {
        setBusy(`Preparing page ${i + 1} of ${pages.length}…`);
        await new Promise((r) => setTimeout(r, 0)); // let the status paint
        const c = renderPage(pages[i].source, pages[i].quad, mode, PAGE_MAX_WIDTH);
        const blob = await canvasToJpeg(c);
        out.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height });
      }
      const bytes = await buildPdf(out, PDFDocument, { title: `${docType.toUpperCase()} scan` });
      if (bytes.length > MAX_BYTES) { setBusy(null); return setMsg({ err: true, text: `The PDF is ${(bytes.length / 1048576).toFixed(1)} MB (max 10 MB). Remove a page or switch to B&W.` }); }
      const file = new File([bytes], scanFileName(docType), { type: 'application/pdf' });
      setBusy('Uploading…');
      const err = await onSave({ file, docType, loadId: loadId || null });
      setBusy(null);
      if (err) setMsg({ err: true, text: err });
    } catch (e) {
      console.error('[scan] save', e); setBusy(null);
      setMsg({ err: true, text: "Couldn't create the PDF. Please try again." });
    }
  }

  function close() {
    if (pages.length && !window.confirm('Discard this scan?')) return;
    onClose();
  }

  const n = pages.length;
  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Scan document"
      onKeyDown={(e) => { if (e.key === 'Escape' && editing == null && !busy) close(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#f8fafc', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui', outline: 'none' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', background: '#fff', paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <button type="button" onClick={close} disabled={!!busy} style={btn} aria-label="Close scanner">✕</button>
        <h2 style={{ fontSize: '1.1rem', margin: 0, flex: 1 }}>Scan document{n ? ` · ${n} page${n > 1 ? 's' : ''}` : ''}</h2>
        <div role="group" aria-label="Colour" style={{ display: 'inline-flex' }}>
          {[['bw', 'B&W'], ['color', 'Color']].map(([m, l]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} disabled={!!busy}
              style={{ ...btn, borderRadius: m === 'bw' ? '8px 0 0 8px' : '0 8px 8px 0', background: mode === m ? '#1d4ed8' : '#fff', color: mode === m ? '#fff' : '#111827' }}>{l}</button>
          ))}
        </div>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', maxWidth: 1120, width: '100%', margin: '0 auto' }}>
        <div aria-live="polite" style={{ minHeight: 24 }}>
          {busy ? <p style={{ margin: '0 0 0.5rem', color: '#1d4ed8' }}>{busy}</p>
            : msg ? <p role={msg.err ? 'alert' : undefined} style={{ margin: '0 0 0.5rem', color: msg.err ? '#b91c1c' : '#374151' }}>{msg.text}</p> : null}
        </div>
        {n === 0 && !busy && <p style={{ color: '#6b7280' }}>No pages yet. Tap "Add page" to take a photo of the document.</p>}
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {pages.map((p, i) => (
            <li key={p.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 13, color: '#6b7280' }}>Page {i + 1}{!p.detected ? ' · not cropped' : ''}</div>
              <img src={p.thumb} alt={`Page ${i + 1} preview`} style={{ width: '100%', aspectRatio: '17 / 22', objectFit: 'contain', background: '#f1f5f9', borderRadius: 6 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" style={{ ...btn, flex: 1, padding: 0 }} disabled={i === 0 || !!busy} onClick={() => setPages((ps) => movePage(ps, i, i - 1))} aria-label={`Move page ${i + 1} earlier`}>◀</button>
                <button type="button" style={{ ...btn, flex: 1, padding: 0 }} disabled={i === n - 1 || !!busy} onClick={() => setPages((ps) => movePage(ps, i, i + 1))} aria-label={`Move page ${i + 1} later`}>▶</button>
              </div>
              <button type="button" style={btn} disabled={!!busy} onClick={() => setEditing(i)}>Adjust corners</button>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" style={{ ...btn, flex: 1 }} disabled={!!busy} onClick={() => { retakeIdx.current = i; retakeRef.current?.click(); }}>Retake</button>
                <PageDelete disabled={!!busy} onDelete={() => setPages((ps) => removePage(ps, i))} n={i + 1} />
              </div>
            </li>
          ))}
        </ol>
      </div>

      <footer style={{ borderTop: '1px solid #e5e7eb', background: '#fff', padding: '0.6rem 0.75rem', paddingBottom: 'max(0.6rem, env(safe-area-inset-bottom))' }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" style={btn} disabled={!!busy} onClick={() => addRef.current?.click()}>＋ Add page</button>
          <div role="group" aria-label="Document type" style={{ display: 'inline-flex' }}>
            {DOC_TYPES.map((t, k) => (
              <button key={t.id} type="button" aria-pressed={docType === t.id} onClick={() => setDocType(t.id)} disabled={!!busy}
                style={{ ...btn, borderRadius: k === 0 ? '8px 0 0 8px' : '0 8px 8px 0', background: docType === t.id ? '#1d4ed8' : '#fff', color: docType === t.id ? '#fff' : '#111827' }}>{t.label}</button>
            ))}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '1 1 180px', minWidth: 0 }}>
            <span style={{ fontSize: 14, color: '#374151' }}>Load</span>
            <select value={loadId} onChange={(e) => setLoadId(e.target.value)} disabled={!!busy} style={{ flex: 1, minWidth: 0, minHeight: 44, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', padding: '0 0.5rem' }}>
              <option value="">No load</option>
              {loads.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>
          <button type="button" style={{ ...primary, opacity: !n || busy ? 0.6 : 1 }} disabled={!n || !!busy} onClick={save}>Save PDF</button>
        </div>
      </footer>

      {/* Own inputs: image-only + rear camera. Never shares an input with the PDF-only picker (Android chooser bug). */}
      <input ref={addRef} type="file" accept="image/*" capture="environment" multiple hidden
        onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; addFiles(f); }} />
      <input ref={retakeRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) addFiles(f.slice(0, 1), retakeIdx.current); }} />

      {editing != null && pages[editing] && (
        <CornerEditor page={pages[editing]} index={editing}
          onCancel={() => setEditing(null)}
          onApply={(q) => { updateQuad(editing, q); setEditing(null); }} />
      )}
    </div>
  );
}

// Inline delete confirm (pick 4A): no modal.
function PageDelete({ onDelete, disabled, n }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" disabled={disabled} onClick={() => setAsk(true)} style={{ ...btn, flex: 1, border: '1px solid #fecaca', color: '#b91c1c' }} aria-label={`Delete page ${n}`}>Delete</button>;
  return (
    <span style={{ display: 'flex', gap: 6, flex: 2 }}>
      <button type="button" autoFocus onClick={() => setAsk(false)} style={{ ...btn, flex: 1 }}>Cancel</button>
      <button type="button" onClick={onDelete} style={{ ...btn, flex: 1, border: 'none', background: '#b91c1c', color: '#fff' }}>Confirm</button>
    </span>
  );
}

// Drag the 4 corners on the photo. 44px handles; arrow keys nudge the focused handle.
function CornerEditor({ page, index, onCancel, onApply }) {
  const { source } = page;
  const [q, setQ] = useState(page.quad.map((p) => ({ ...p })));
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const [scale, setScale] = useState(1);
  const drag = useRef(null);

  useEffect(() => {
    const fit = () => {
      const box = boxRef.current; if (!box) return;
      const k = Math.min(box.clientWidth / source.width, box.clientHeight / source.height);
      setScale(k);
      const c = canvasRef.current; c.width = Math.round(source.width * k); c.height = Math.round(source.height * k);
      c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    };
    fit();
    window.addEventListener('resize', fit); window.addEventListener('orientationchange', fit);
    return () => { window.removeEventListener('resize', fit); window.removeEventListener('orientationchange', fit); };
  }, [source]);

  const clamp = (p) => ({ x: Math.min(source.width, Math.max(0, p.x)), y: Math.min(source.height, Math.max(0, p.y)) });
  const move = (i, p) => setQ((cur) => cur.map((c, k) => (k === i ? clamp(p) : c)));
  const onPointerMove = (e) => {
    if (drag.current == null) return;
    const r = canvasRef.current.getBoundingClientRect();
    move(drag.current, { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale });
  };
  const names = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];
  const W = Math.round(source.width * scale), H = Math.round(source.height * scale);

  return (
    <div role="dialog" aria-modal="true" aria-label={`Adjust corners, page ${index + 1}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      style={{ position: 'fixed', inset: 0, zIndex: 2100, background: '#111827', display: 'flex', flexDirection: 'column' }}>
      <div ref={boxRef} style={{ flex: 1, position: 'relative', margin: 16, touchAction: 'none' }}
        onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div style={{ position: 'absolute', left: '50%', top: '50%', width: W, height: H, transform: 'translate(-50%, -50%)' }}>
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          <svg width={W} height={H} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden="true">
            <polygon points={q.map((p) => `${p.x * scale},${p.y * scale}`).join(' ')} fill="rgba(37,99,235,0.15)" stroke="#3b82f6" strokeWidth="2" />
          </svg>
          {q.map((p, i) => (
            <button key={i} type="button" aria-label={`${names[i]} corner. Use arrow keys to move.`}
              onPointerDown={(e) => { e.preventDefault(); drag.current = i; e.currentTarget.focus(); }}
              onKeyDown={(e) => {
                const step = (e.shiftKey ? 20 : 4) / scale;
                const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                if (d) { e.preventDefault(); move(i, { x: p.x + d[0], y: p.y + d[1] }); }
              }}
              style={{ position: 'absolute', left: p.x * scale - 22, top: p.y * scale - 22, width: 44, height: 44, borderRadius: 999, border: '3px solid #fff', background: 'rgba(37,99,235,0.85)', touchAction: 'none', cursor: 'grab', padding: 0 }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', padding: '0.6rem', paddingBottom: 'max(0.6rem, env(safe-area-inset-bottom))', background: '#fff' }}>
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
        <button type="button" style={btn} onClick={() => setQ(detect(source).quad)}>Auto-detect</button>
        <button type="button" style={btn} onClick={() => setQ(fullFrame(source.width, source.height))}>Use full photo</button>
        <button type="button" style={primary} onClick={() => onApply(q)}>Apply</button>
      </div>
    </div>
  );
}
