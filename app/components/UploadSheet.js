'use client';

import { useEffect, useId, useRef, useState } from 'react';

// One trigger button that opens an in-app action sheet with three pickers, each backed by its
// own hidden input. Android Chrome collapses a combined accept list into "camera/photos only",
// so we give each source its own input: camera, photo library, and Files/PDF (Files app + Drive).
const OPTIONS = [
  { id: 'camera', emoji: '📷', label: 'Take photo', accept: 'image/*', capture: 'environment' },
  { id: 'library', emoji: '🖼️', label: 'Photo library', accept: 'image/*' },
  { id: 'files', emoji: '📄', label: 'Files / PDF', accept: 'application/pdf' },
];

const optBtn = {
  display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', minHeight: 52,
  padding: '0.75rem 1rem', fontSize: '1.05rem', textAlign: 'left', background: '#fff',
  border: '1px solid #e5e7eb', borderRadius: 10, color: '#111827', cursor: 'pointer',
};

export default function UploadSheet({ label, title, onPick, disabled = false, resetKey = 0, triggerStyle }) {
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const triggerRef = useRef(null);
  const sheetRef = useRef(null);
  const inputs = useRef({});
  const titleId = useId();

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const upd = () => setDesktop(mq.matches);
    upd();
    mq.addEventListener?.('change', upd);
    return () => mq.removeEventListener?.('change', upd);
  }, []);

  useEffect(() => { if (disabled && open) setOpen(false); }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = sheetRef.current?.querySelector('button');
    first?.focus();
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function choose(id) {
    // Click the input synchronously (still inside the user gesture), then close.
    inputs.current[id]?.click();
    close();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(sheetRef.current?.querySelectorAll('button:not([disabled])') || []);
    if (!items.length) return;
    const firstEl = items[0], lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  }

  const panel = desktop
    ? { position: 'relative', width: '100%', maxWidth: 380, margin: 'auto', borderRadius: 14, padding: '1.25rem' }
    : {
        position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '16px 16px 0 0',
        padding: '1rem 1rem calc(1rem + env(safe-area-inset-bottom))',
        paddingLeft: 'calc(1rem + env(safe-area-inset-left))', paddingRight: 'calc(1rem + env(safe-area-inset-right))',
      };

  return (
    <>
      {OPTIONS.map((o) => (
        <input key={`${o.id}-${resetKey}`} ref={(el) => { inputs.current[o.id] = el; }} type="file" accept={o.accept}
          {...(o.capture ? { capture: o.capture } : {})} tabIndex={-1} aria-hidden="true"
          onChange={(e) => onPick(e.target.files?.[0] || null)} style={{ display: 'none' }} />
      ))}
      <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{ width: '100%', minHeight: 48, fontSize: '1rem', fontWeight: 600, borderRadius: 10, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', opacity: disabled ? 0.6 : 1, ...triggerStyle }}>
        {label}
      </button>
      {open && (
        <div onKeyDown={onKeyDown} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', padding: desktop ? '1rem' : 0 }}>
          <div onClick={() => close()} aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(17,24,39,0.5)' }} />
          <div ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
            style={{ ...panel, background: '#f9fafb', boxShadow: '0 -4px 24px rgba(0,0,0,0.2)', boxSizing: 'border-box', display: 'grid', gap: '0.5rem' }}>
            <h2 id={titleId} style={{ margin: '0 0 0.25rem', fontSize: '1.1rem', textAlign: 'center' }}>{title}</h2>
            {OPTIONS.map((o) => (
              <button key={o.id} type="button" onClick={() => choose(o.id)} style={optBtn}>
                <span aria-hidden="true" style={{ fontSize: '1.3rem' }}>{o.emoji}</span>{o.label}
              </button>
            ))}
            <button type="button" onClick={() => close()} style={{ ...optBtn, justifyContent: 'center', fontWeight: 600, marginTop: '0.25rem' }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
