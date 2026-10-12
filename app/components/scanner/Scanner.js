'use client';

import { useEffect, useRef, useState } from 'react';
import { movePage, removePage, replacePage, fullFrame, buildPdf, scanFileName, capPages, PAGE_MAX_WIDTH, MAX_PAGES } from '../../lib/scan';
import { loadPhoto, redetect, renderPageJpeg, renderThumbUrl, bitmapOf, release, revoke, rejectReason } from './imaging';

// Full-screen BOL/POD scanner. Loaded lazily (next/dynamic) only when a scan starts, so pdf-lib and
// the image code never ship with the normal page. Edge detection is a small built-in heuristic
// (no OpenCV). Weak or missing detections keep the full photo and open the corner editor.
// Memory: a page is { orig (undecoded original Blob), blob (preview JPEG <= 1700px), w, h, quad, detected, thumb (object URL) },
// with no live canvases. Save decodes one original at a time (scaled to ~3000px) and releases it before the next.
//
// TODO(pick 7, open): doc types come from one shared docTypes.js list once Marc decides.
// BOL/POD are used here because the scanner needs them.
const DOC_TYPES = [{ id: 'bol', label: 'BOL' }, { id: 'pod', label: 'POD' }];
const MAX_BYTES = 10 * 1024 * 1024;
const NO_PHOTO = "No photo was captured. If the camera didn't open, allow camera access for this site in your browser settings, or use \"Choose photos\".";

const btn = { minHeight: 44, minWidth: 44, padding: '0 0.8rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#111827', fontSize: '0.95rem', cursor: 'pointer' };
const primary = { ...btn, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600 };
let nextId = 1;

export default function Scanner({ initialFiles = [], loads = [], initialLoadId = '', onClose, onSave }) {
  const [pages, setPages] = useState([]);
  const pagesRef = useRef(pages); pagesRef.current = pages;
  const [mode, setMode] = useState('bw');
  const modeRef = useRef(mode); modeRef.current = mode;
  const [docType, setDocType] = useState('bol');
  const [loadId, setLoadId] = useState(initialLoadId || '');
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const cameraRef = useRef(null);
  const chooseRef = useRef(null);
  const retakeRef = useRef(null);
  const retakeIdx = useRef(null);
  const dialogRef = useRef(null);
  const keepRef = useRef(null);
  const pending = useRef(null); // which input is open, for "nothing captured" feedback
  const firstMode = useRef(true);
  const loadingRef = useRef(false); // true while photos are being processed

  useEffect(() => {
    const opener = document.activeElement; // focus goes back here on close
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    if (initialFiles.length) addFiles(initialFiles);
    else setMsg({ text: 'Tap "Take photo" to photograph each page, or "Choose photos" to pick saved images.' });
    return () => {
      document.body.style.overflow = prev;
      pagesRef.current.forEach((p) => revoke(p.thumb));
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') setTimeout(() => opener.focus(), 0);
    };
  }, []);

  // Re-render thumbnails when B&W/Color changes (one at a time; old URLs revoked).
  useEffect(() => {
    if (firstMode.current) { firstMode.current = false; return undefined; }
    let stop = false;
    (async () => {
      for (const p of pagesRef.current) {
        if (stop) return;
        const url = await renderThumbUrl(p, mode).catch(() => null);
        if (stop) { revoke(url); return; }
        if (!url) continue;
        setPages((ps) => ps.map((x) => (x.id === p.id ? (revoke(x.thumb), { ...x, thumb: url }) : x)));
      }
    })();
    return () => { stop = true; };
  }, [mode]);
  useEffect(() => { if (askDiscard) keepRef.current?.focus(); }, [askDiscard]);

  // "Nothing captured" feedback: the input's cancel event, or focus returning with no change event.
  function openInput(ref, kind) {
    const input = ref.current; if (!input) return;
    pending.current = kind;
    const nothing = () => { if (pending.current === kind && !loadingRef.current) { pending.current = null; setMsg({ err: true, text: NO_PHOTO }); } };
    // Primary signal: the input's cancel event. Fallback for browsers without it: ~4 s after focus
    // returns, only if no file arrived (change clears `pending`) and none is still loading.
    input.addEventListener('cancel', nothing, { once: true });
    window.addEventListener('focus', () => setTimeout(nothing, 4000), { once: true });
    input.click();
  }
  function takeFiles(e) {
    pending.current = null;
    const f = Array.from(e.target.files || []);
    e.target.value = '';
    if (!f.length) setMsg({ err: true, text: NO_PHOTO });
    return f;
  }

  async function addFiles(files, replaceAt = null) {
    if (!files.length) return;
    loadingRef.current = true;
    try { await addFilesInner(files, replaceAt); } finally { loadingRef.current = false; }
  }

  async function addFilesInner(files, replaceAt) {
    setMsg(null);
    let list = files, capped = 0;
    if (replaceAt == null) { const c = capPages(pagesRef.current.length, files); list = c.accepted; capped = c.rejected; }
    const added = [], failed = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(`Processing photo ${i + 1} of ${list.length}…`);
      try {
        const why = rejectReason(list[i]);
        if (why) throw new Error(why);
        const page = { id: nextId++, ...(await loadPhoto(list[i])), thumb: null };
        page.thumb = await renderThumbUrl(page, modeRef.current);
        added.push(page);
      } catch (e) {
        console.error('[scan] photo', e);
        failed.push(`${list[i].name || 'photo'} (${e.message?.endsWith('.') ? e.message.slice(0, -1) : 'try JPEG or PNG'})`);
      }
    }
    setBusy(null);
    const base = pagesRef.current;
    let next = base;
    if (added.length) {
      if (replaceAt != null) { revoke(base[replaceAt]?.thumb); next = replacePage(base, replaceAt, added[0]); }
      else next = [...base, ...added];
      pagesRef.current = next;
      setPages(next);
    }
    const notes = [];
    if (added.length) notes.push(`${added.length} page${added.length > 1 ? 's' : ''} ${replaceAt != null ? 'replaced' : 'added'}.`);
    if (capped) notes.push(`Limit reached: a scan can have at most ${MAX_PAGES} pages, so ${capped} photo${capped > 1 ? 's were' : ' was'} not added. Save this PDF and start another scan for the rest.`);
    if (failed.length) notes.push(`Couldn't read ${failed.join(', ')}.`);
    const firstWeak = next.findIndex((p) => added.includes(p) && !p.detected);
    if (firstWeak >= 0) notes.push("Couldn't find clear page edges, so the full photo is kept. Drag the corners to crop, or tap \"Use full photo\".");
    if (notes.length) setMsg({ err: !!(capped || failed.length), text: notes.join(' ') });
    if (firstWeak >= 0) setEditing(firstWeak);
  }

  async function updateQuad(i, quad) {
    const p = pagesRef.current[i];
    const np = { ...p, quad, detected: true };
    np.thumb = await renderThumbUrl(np, modeRef.current).catch(() => p.thumb);
    if (np.thumb !== p.thumb) revoke(p.thumb);
    setPages((ps) => ps.map((x) => (x.id === p.id ? np : x)));
  }

  function deletePage(i) {
    revoke(pagesRef.current[i]?.thumb);
    setPages((ps) => removePage(ps, i));
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
        out.push(await renderPageJpeg(pages[i], mode, PAGE_MAX_WIDTH));
      }
      const bytes = await buildPdf(out, PDFDocument, { title: `${docType.toUpperCase()} scan` });
      out.length = 0;
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
    if (pagesRef.current.length) return setAskDiscard(true); // inline confirm (pick 4A), no window.confirm
    onClose();
  }

  const n = pages.length;
  const full = n >= MAX_PAGES;
  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Scan document"
      onKeyDown={(e) => { if (e.key === 'Escape' && editing == null && !busy && !askDiscard) close(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#f8fafc', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui', outline: 'none' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', background: '#fff', paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        {askDiscard ? (
          <span role="group" aria-label="Discard this scan?" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAskDiscard(false); } }}>
            <span style={{ fontSize: 14 }}>Discard {n} page{n > 1 ? 's' : ''}?</span>
            <button ref={keepRef} type="button" style={btn} onClick={() => setAskDiscard(false)}>Keep</button>
            <button type="button" style={{ ...btn, border: 'none', background: '#b91c1c', color: '#fff' }} onClick={onClose}>Discard</button>
          </span>
        ) : (
          <button type="button" onClick={close} disabled={!!busy} style={btn} aria-label="Close scanner">✕</button>
        )}
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
        <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 0.75rem' }}>
          Tip: lay the page flat on a darker surface, fill most of the frame and avoid glare. Up to {MAX_PAGES} pages per scan.
        </p>
        {n === 0 && !busy && <p style={{ color: '#6b7280' }}>No pages yet.</p>}
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {pages.map((p, i) => (
            <li key={p.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 13, color: '#6b7280' }}>Page {i + 1}{!p.detected ? ' · not cropped' : ''}</div>
              {p.thumb ? <img src={p.thumb} alt={`Page ${i + 1} preview`} style={{ width: '100%', aspectRatio: '17 / 22', objectFit: 'contain', background: '#f1f5f9', borderRadius: 6 }} />
                : <div style={{ width: '100%', aspectRatio: '17 / 22', background: '#f1f5f9', borderRadius: 6 }} />}
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" style={{ ...btn, flex: 1, padding: 0 }} disabled={i === 0 || !!busy} onClick={() => setPages((ps) => movePage(ps, i, i - 1))} aria-label={`Move page ${i + 1} earlier`}>◀</button>
                <button type="button" style={{ ...btn, flex: 1, padding: 0 }} disabled={i === n - 1 || !!busy} onClick={() => setPages((ps) => movePage(ps, i, i + 1))} aria-label={`Move page ${i + 1} later`}>▶</button>
              </div>
              <button type="button" style={btn} disabled={!!busy} onClick={() => setEditing(i)}>Adjust corners</button>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" style={{ ...btn, flex: 1 }} disabled={!!busy} onClick={() => { retakeIdx.current = i; openInput(retakeRef, 'retake'); }}>Retake</button>
                <PageDelete disabled={!!busy} onDelete={() => deletePage(i)} n={i + 1} />
              </div>
            </li>
          ))}
        </ol>
      </div>

      <footer style={{ borderTop: '1px solid #e5e7eb', background: '#fff', padding: '0.6rem 0.75rem', paddingBottom: 'max(0.6rem, env(safe-area-inset-bottom))' }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" style={btn} disabled={!!busy || full} onClick={() => openInput(cameraRef, 'camera')}>📷 Take photo</button>
          <button type="button" style={btn} disabled={!!busy || full} onClick={() => openInput(chooseRef, 'choose')}>🖼️ Choose photos</button>
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

      {/* Own inputs, never shared with the PDF-only picker (Android chooser bug). Camera = capture; Choose = no capture. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => addFiles(takeFiles(e))} />
      <input ref={chooseRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(takeFiles(e))} />
      <input ref={retakeRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { const f = takeFiles(e); if (f.length) addFiles(f.slice(0, 1), retakeIdx.current); }} />

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
// Focus moves to the first handle on open; Esc cancels (focus returns to the scanner dialog).
function CornerEditor({ page, index, onCancel, onApply }) {
  const [q, setQ] = useState(page.quad.map((p) => ({ ...p })));
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const firstRef = useRef(null);
  const [scale, setScale] = useState(0);
  const drag = useRef(null);

  useEffect(() => {
    const opener = document.activeElement;
    let bmp = null, alive = true;
    const fit = () => {
      const box = boxRef.current, c = canvasRef.current; if (!box || !c || !bmp) return;
      const k = Math.min(box.clientWidth / page.w, box.clientHeight / page.h);
      setScale(k);
      c.width = Math.round(page.w * k); c.height = Math.round(page.h * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    };
    (async () => {
      bmp = await bitmapOf(page.blob);
      if (!alive) return release(bmp);
      fit();
      setTimeout(() => firstRef.current?.focus(), 0);
    })();
    window.addEventListener('resize', fit); window.addEventListener('orientationchange', fit);
    return () => {
      alive = false;
      window.removeEventListener('resize', fit); window.removeEventListener('orientationchange', fit);
      release(bmp, canvasRef.current);
      if (opener && opener.isConnected && typeof opener.focus === 'function') setTimeout(() => opener.focus(), 0);
    };
  }, [page.blob]);

  const clamp = (p) => ({ x: Math.min(page.w, Math.max(0, p.x)), y: Math.min(page.h, Math.max(0, p.y)) });
  const move = (i, p) => setQ((cur) => cur.map((c, k) => (k === i ? clamp(p) : c)));
  const onPointerMove = (e) => {
    if (drag.current == null || !scale) return;
    const r = canvasRef.current.getBoundingClientRect();
    move(drag.current, { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale });
  };
  const names = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];
  const W = Math.round(page.w * scale), H = Math.round(page.h * scale);

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
            <button key={i} ref={i === 0 ? firstRef : undefined} type="button" aria-label={`${names[i]} corner. Use arrow keys to move.`}
              onPointerDown={(e) => { e.preventDefault(); drag.current = i; e.currentTarget.focus(); }}
              onKeyDown={(e) => {
                const step = (e.shiftKey ? 20 : 4) / (scale || 1);
                const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                if (d) { e.preventDefault(); move(i, { x: p.x + d[0], y: p.y + d[1] }); }
              }}
              style={{ position: 'absolute', left: p.x * scale - 22, top: p.y * scale - 22, width: 44, height: 44, borderRadius: 999, border: '3px solid #fff', background: 'rgba(37,99,235,0.85)', touchAction: 'none', cursor: 'grab', padding: 0 }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', padding: '0.6rem', paddingBottom: 'max(0.6rem, env(safe-area-inset-bottom))', background: '#fff' }}>
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
        <button type="button" style={btn} onClick={async () => setQ((await redetect(page)).quad)}>Auto-detect</button>
        <button type="button" style={btn} onClick={() => setQ(fullFrame(page.w, page.h))}>Use full photo</button>
        <button type="button" style={primary} onClick={() => onApply(q)}>Apply</button>
      </div>
    </div>
  );
}
