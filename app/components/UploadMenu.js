'use client';

import { useEffect, useId, useRef, useState } from 'react';

// One "Upload" button that opens a small menu with three options, each backed by its own
// hidden input. Files / PDF uses a PDF-only accept with NO capture, which makes Android open
// its file browser (including Google Drive) instead of the camera. Each pick calls onFile(file);
// the input value is cleared afterwards so picking the same file again still fires.
const OPTIONS = [
  { id: 'camera', icon: '📷', label: 'Take photo', accept: 'image/*', capture: 'environment' },
  { id: 'library', icon: '🖼️', label: 'Photo library', accept: 'image/*' },
  { id: 'files', icon: '📄', label: 'Files / PDF', accept: 'application/pdf' },
];

const st = {
  wrap: { position: 'relative' },
  trigger: { width: '100%', minHeight: 48, padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8', touchAction: 'manipulation' },
  menu: { position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 60, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: '0.25rem', margin: 0, listStyle: 'none' },
  item: { display: 'block', width: '100%', textAlign: 'left', minHeight: 48, padding: '0.6rem 0.8rem', fontSize: '1rem', border: 'none', borderRadius: 8, background: 'transparent', color: '#111827', touchAction: 'manipulation' },
};

export default function UploadMenu({ onFile, disabled = false, label = 'Upload' }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  const inputRefs = useRef({});
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    itemRefs.current[0]?.focus();
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onMenuKey = (e) => {
    const items = itemRefs.current.filter(Boolean);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  // Open upward when there isn't room below (bottom nav + safe area on short phones).
  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const nav = document.querySelector('.appnav-bottom')?.getBoundingClientRect().height || 0;
      const below = window.innerHeight - r.bottom - nav;
      const need = OPTIONS.length * 48 + 16;
      setUp(below < need && r.top > below);
    }
    setOpen((v) => !v);
  };

  const refocus = () => setTimeout(() => triggerRef.current?.focus(), 0);

  const choose = (id) => {
    setOpen(false);
    const input = inputRefs.current[id];
    if (!input) return;
    // Return focus to the trigger after a pick or a cancel. 'cancel' isn't fired everywhere,
    // so also catch the window regaining focus when the native picker closes.
    const onBack = () => { window.removeEventListener('focus', onBack); refocus(); };
    window.addEventListener('focus', onBack);
    input.click();
  };

  return (
    <div ref={wrapRef} style={st.wrap}>
      {OPTIONS.map((o) => (
        <input key={o.id} ref={(el) => { inputRefs.current[o.id] = el; }} type="file" accept={o.accept}
          {...(o.capture ? { capture: o.capture } : {})} tabIndex={-1} aria-hidden="true" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; refocus(); if (f) onFile(f); }}
          onCancel={refocus} />
      ))}
      <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        onClick={toggle} style={{ ...st.trigger, opacity: disabled ? 0.6 : 1 }}>
        <span aria-hidden="true">⬆️ </span>{label}
      </button>
      {open && (
        <ul id={menuId} role="menu" aria-label="Upload from" style={{ ...st.menu, ...(up ? { top: 'auto', bottom: 'calc(100% + 4px)' } : null) }} onKeyDown={onMenuKey}>
          {OPTIONS.map((o, i) => (
            <li key={o.id} role="none">
              <button ref={(el) => { itemRefs.current[i] = el; }} type="button" role="menuitem" onClick={() => choose(o.id)} style={st.item}>
                <span aria-hidden="true">{o.icon} </span>{o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
