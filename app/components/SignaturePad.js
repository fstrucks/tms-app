'use client';

// Step E: standalone signature pad. Draw (Pointer Events) or Type (script font).
// onDone({ dataUrl, signerName, signedAt, method }); dataUrl is a trimmed transparent PNG.
// Note: when the pad width changes (rotation/resize) a drawn signature is cleared, and the
// user sees "Pad resized — please sign again." Typed signatures re-render automatically.
// Not wired into packets/PDF yet (Alex integrates).

import { useCallback, useEffect, useRef, useState } from 'react';
import localFont from 'next/font/local';
import { buildSignaturePayload, canFinish, cleanSignerName, findInkBounds, midpoint, SIGNER_NAME_MAX } from '../lib/signature.js';

// Dancing Script (SIL OFL 1.1, app/fonts/dancing-script/OFL.txt), self-hosted via next/font/local; no CDN at runtime.
const dancing = localFont({
  src: '../fonts/dancing-script/DancingScript-Variable.woff2',
  weight: '400 700',
  display: 'swap',
  fallback: ['Segoe Script', 'Brush Script MT', 'Snell Roundhand', 'Apple Chancery', 'Lucida Handwriting', 'cursive'],
});
// Canvas font string; dancing.style.fontFamily already includes the cursive fallbacks above.
const scriptFont = (size) => `500 ${size}px ${dancing.style.fontFamily}`;
const PAD_HEIGHT = 180;
const INK = '#111827';
const btn = { minHeight: 44, minWidth: 44, padding: '0 1rem', borderRadius: 10, fontSize: 16, fontWeight: 600, cursor: 'pointer' };

export default function SignaturePad({ onDone, onCancel, initialName = '', title = 'Sign here' }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const drawing = useRef(null); // { last, mid } while a stroke is active
  const widthRef = useRef(0);
  const [method, setMethod] = useState('draw');
  const [signerName, setSignerName] = useState(initialName);
  const [hasInk, setHasInk] = useState(false);
  const [notice, setNotice] = useState('');
  const drawnRef = useRef(false); // true only when ink was drawn by hand (not typed)
  const renderSeq = useRef(0);

  // willReadFrequently: Done reads pixels back with getImageData.
  const ctx = () => canvasRef.current?.getContext('2d', { willReadFrequently: true });

  // Waits for the bundled script font before drawing (falls back to cursive if it fails to load).
  const renderTyped = useCallback(async () => {
    const seq = ++renderSeq.current;
    try { await document.fonts?.load(scriptFont(56), cleanSignerName(signerName) || 'Signature'); } catch {}
    if (seq !== renderSeq.current) return;
    const c = canvasRef.current, g = ctx();
    if (!c || !g) return;
    const w = c.width / (window.devicePixelRatio || 1);
    g.clearRect(0, 0, c.width, c.height);
    const text = cleanSignerName(signerName);
    if (!text) return;
    let size = 56;
    g.font = scriptFont(size);
    while (size > 18 && g.measureText(text).width > w - 32) { size -= 2; g.font = scriptFont(size); }
    g.fillStyle = INK;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText(text, w / 2, PAD_HEIGHT / 2);
  }, [signerName]);

  const sizeCanvas = useCallback(() => {
    const c = canvasRef.current, wrap = wrapRef.current;
    if (!c || !wrap) return;
    const w = Math.floor(wrap.clientWidth);
    if (!w || w === widthRef.current) return;
    const resized = widthRef.current !== 0;
    widthRef.current = w;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(PAD_HEIGHT * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${PAD_HEIGHT}px`;
    const g = ctx();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 2.5; g.strokeStyle = INK;
    // Only tell the user to re-sign if they had actually drawn something; typed signatures re-render.
    if (resized && drawnRef.current) setNotice('Pad resized — please sign again.');
    drawnRef.current = false;
    setHasInk(false);
  }, []);

  useEffect(() => {
    sizeCanvas();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sizeCanvas()) : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    else window.addEventListener('resize', sizeCanvas);
    return () => { ro ? ro.disconnect() : window.removeEventListener('resize', sizeCanvas); };
  }, [sizeCanvas]);

  useEffect(() => { if (method === 'type') renderTyped(); }, [method, renderTyped, hasInk]);

  const point = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e) => {
    if (method !== 'draw') return;
    e.preventDefault();
    canvasRef.current.setPointerCapture?.(e.pointerId);
    const p = point(e);
    const g = ctx();
    g.beginPath(); g.arc(p.x, p.y, g.lineWidth / 2, 0, Math.PI * 2); g.fillStyle = INK; g.fill();
    drawing.current = { last: p, mid: p, id: e.pointerId };
    drawnRef.current = true;
    setNotice('');
    setHasInk(true);
  };
  const onPointerMove = (e) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    const g = ctx();
    const events = e.nativeEvent.getCoalescedEvents?.() || [e.nativeEvent];
    for (const ev of events) {
      const p = point(ev);
      const m = midpoint(d.last, p);
      g.beginPath(); g.moveTo(d.mid.x, d.mid.y); g.quadraticCurveTo(d.last.x, d.last.y, m.x, m.y); g.stroke();
      d.last = p; d.mid = m;
    }
  };
  const onPointerUp = (e) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    const g = ctx();
    g.beginPath(); g.moveTo(d.mid.x, d.mid.y); g.lineTo(d.last.x, d.last.y); g.stroke();
    drawing.current = null;
  };

  const clear = () => {
    const c = canvasRef.current;
    ctx()?.clearRect(0, 0, c.width, c.height);
    drawing.current = null;
    drawnRef.current = false;
    setHasInk(false); setNotice('');
    if (method === 'type') setSignerName('');
  };

  const switchMethod = (m) => {
    if (m === method) return;
    const c = canvasRef.current;
    ctx()?.clearRect(0, 0, c.width, c.height);
    drawnRef.current = false;
    setHasInk(false); setNotice(''); setMethod(m);
  };

  const ready = canFinish({ signerName, method, hasInk });

  const done = async () => {
    if (!ready) return;
    if (method === 'type') await renderTyped();
    const c = canvasRef.current;
    const img = ctx().getImageData(0, 0, c.width, c.height);
    const dpr = window.devicePixelRatio || 1;
    const b = findInkBounds(img.data, c.width, c.height, Math.round(8 * dpr));
    if (!b) { setNotice('Please sign first.'); return; }
    const out = document.createElement('canvas');
    out.width = b.w; out.height = b.h;
    out.getContext('2d').drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    const payload = buildSignaturePayload({ dataUrl: out.toDataURL('image/png'), signerName, method });
    if (payload) onDone?.(payload);
  };

  const tab = (m, label) => (
    <button type="button" role="tab" aria-selected={method === m} onClick={() => switchMethod(m)}
      style={{ ...btn, flex: 1, border: 'none', background: method === m ? '#fff' : 'transparent', color: '#111827', boxShadow: method === m ? '0 1px 2px rgba(0,0,0,0.12)' : 'none' }}>
      {label}
    </button>
  );

  return (
    <div style={{ width: '100%', maxWidth: 640, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {title && <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, fontWeight: 600 }}>
        Signer name
        <input type="text" value={signerName} maxLength={SIGNER_NAME_MAX} autoComplete="name" placeholder="Full name"
          onChange={(e) => setSignerName(e.target.value)}
          style={{ minHeight: 44, fontSize: 16, padding: '0 0.75rem', border: '1px solid #d1d5db', borderRadius: 10 }} />
      </label>
      <div role="tablist" aria-label="Signature method" style={{ display: 'flex', gap: 4, padding: 4, background: '#f3f4f6', borderRadius: 12 }}>
        {tab('draw', 'Draw')}
        {tab('type', 'Type')}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', width: '100%', border: '1px dashed #9ca3af', borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
        <canvas ref={canvasRef} aria-label={method === 'draw' ? 'Signature drawing area' : 'Typed signature preview'}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          style={{ display: 'block', width: '100%', height: PAD_HEIGHT, touchAction: 'none', cursor: method === 'draw' ? 'crosshair' : 'default' }} />
        <div aria-hidden="true" style={{ position: 'absolute', left: 16, right: 16, bottom: 36, borderBottom: '1px solid #e5e7eb', pointerEvents: 'none' }} />
        {method === 'draw' && !hasInk && (
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', pointerEvents: 'none' }}>
            Sign with your finger or mouse
          </div>
        )}
      </div>
      {notice && <div role="status" style={{ color: '#b45309', fontSize: 14 }}>{notice}</div>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {onCancel && <button type="button" onClick={onCancel} style={{ ...btn, background: '#fff', border: '1px solid #d1d5db', color: '#111827' }}>Cancel</button>}
        <button type="button" onClick={clear} style={{ ...btn, background: '#fff', border: '1px solid #d1d5db', color: '#111827' }}>Clear</button>
        <button type="button" onClick={done} disabled={!ready}
          style={{ ...btn, flex: 1, border: 'none', background: ready ? '#2563eb' : '#93c5fd', color: '#fff', cursor: ready ? 'pointer' : 'not-allowed' }}>Done</button>
      </div>
    </div>
  );
}
