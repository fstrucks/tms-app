'use client';

import { useEffect, useId, useRef, useState } from 'react';

// One "Upload" button that opens a small menu with three options, each backed by its own
// hidden input. Files / PDF uses a PDF-only accept with NO capture, which makes Android open
// its file browser (including Google Drive) instead of the camera. Each pick calls onFile(file);
// the input value is cleared afterwards so picking the same file again still fires.
//
// iOS Safari: each menu option is a <label htmlFor> for its input, so a tap opens the picker
// natively (no programmatic input.click(), which iOS drops when it isn't a direct, synchronous
// user activation or when the input is display:none). The inputs stay mounted outside the menu
// and are visually hidden, not display:none. The menu closes on the next tick after the tap,
// so the label isn't unmounted before its activation reaches the input.
const OPTIONS = [
  { id: 'camera', icon: '📷', label: 'Take photo', accept: 'image/*', capture: 'environment' },
  { id: 'library', icon: '🖼️', label: 'Photo library', accept: 'image/*' },
  { id: 'files', icon: '📄', label: 'Files / PDF', accept: 'application/pdf' },
];

// Visually hidden but still "rendered", so iOS honours label activation of the input.
export const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0, opacity: 0 };

const st = {
  wrap: { position: 'relative' },
  trigger: { width: '100%', minHeight: 48, padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8', touchAction: 'manipulation' },
  menu: { position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 1000, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: '0.25rem', margin: 0, listStyle: 'none' },
  item: { display: 'block', boxSizing: 'border-box', cursor: 'pointer', WebkitTapHighlightColor: 'transparent', width: '100%', textAlign: 'left', minHeight: 48, padding: '0.6rem 0.8rem', fontSize: '1rem', border: 'none', borderRadius: 8, background: 'transparent', color: '#111827', touchAction: 'manipulation' },
};

export default function UploadMenu({ onFile, disabled = false, label = 'Upload' }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  const inputRefs = useRef({});
  const menuId = useId();
  const backRef = useRef(null); // pending window-focus listener from choose()

  const clearBack = () => { if (backRef.current) { window.removeEventListener('focus', backRef.current); backRef.current = null; } };
  useEffect(() => clearBack, []);

  // Open upward when there isn't room below: subtract the bottom nav and any sticky bar marked
  // data-upload-avoid (e.g. the Save bar on /expenses) that overlaps the space under the trigger.
  const computeUp = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    let limit = window.innerHeight;
    document.querySelectorAll('.appnav-bottom, [data-upload-avoid]').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.height && b.top > r.bottom && b.top < limit) limit = b.top;
    });
    const below = limit - r.bottom;
    const need = OPTIONS.length * 48 + 16;
    setUp(below < need && r.top > below);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', computeUp);
    window.addEventListener('orientationchange', computeUp);
    itemRefs.current[0]?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', computeUp); window.removeEventListener('orientationchange', computeUp);
    };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onMenuKey = (e) => {
    const items = itemRefs.current.filter(Boolean);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const toggle = () => {
    if (!open) computeUp();
    setOpen((v) => !v);
  };

  // Close when focus moves outside the menu/trigger (keyboard or screen-reader navigation).
  // A tap on iOS can blur with relatedTarget = null before the click lands; outside taps are
  // handled by the pointerdown listener, so only close here when focus really moved elsewhere.
  const onFocusOut = (e) => {
    if (open && e.relatedTarget && wrapRef.current && !wrapRef.current.contains(e.relatedTarget)) setOpen(false);
  };

  const refocus = () => setTimeout(() => triggerRef.current?.focus(), 0);

  // Runs synchronously inside the tap/keypress. Arms focus-return listeners, then closes the
  // menu on the next tick (after the label's native activation has reached the input).
  const arm = (id) => {
    const input = inputRefs.current[id];
    setTimeout(() => setOpen(false), 0);
    if (!input) return null;
    // Return focus to the trigger after a pick or a cancel. 'cancel' isn't fired everywhere,
    // so also catch the window regaining focus when the native picker closes.
    clearBack();
    const onBack = () => { backRef.current = null; refocus(); };
    backRef.current = onBack;
    window.addEventListener('focus', onBack, { once: true });
    // React 18 has no onCancel prop; use the native event (once per open).
    input.addEventListener('cancel', () => { clearBack(); refocus(); }, { once: true });
    return input;
  };

  // Keyboard: Enter/Space on a label doesn't activate it, so click the input directly
  // (still synchronous inside the key event, and the input stays mounted).
  const onItemKey = (e, id) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    arm(id)?.click();
  };

  return (
    <div ref={wrapRef} style={st.wrap} onBlur={onFocusOut}>
      {OPTIONS.map((o) => (
        <input key={o.id} ref={(el) => { inputRefs.current[o.id] = el; }} type="file" accept={o.accept}
          {...(o.capture ? { capture: o.capture } : {})} id={`${menuId}-${o.id}`} tabIndex={-1} aria-hidden="true" style={VISUALLY_HIDDEN}
          onChange={(e) => { clearBack(); const f = e.target.files?.[0] || null; e.target.value = ''; refocus(); if (f) onFile(f); }}
        />
      ))}
      <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        onClick={toggle} style={{ ...st.trigger, opacity: disabled ? 0.6 : 1 }}>
        <span aria-hidden="true">⬆️ </span>{label}
      </button>
      {open && (
        <ul id={menuId} role="menu" aria-label="Upload from" style={{ ...st.menu, ...(up ? { top: 'auto', bottom: 'calc(100% + 4px)' } : null) }} onKeyDown={onMenuKey}>
          {OPTIONS.map((o, i) => (
            <li key={o.id} role="none">
              <label ref={(el) => { itemRefs.current[i] = el; }} htmlFor={`${menuId}-${o.id}`} role="menuitem" tabIndex={-1}
                onClick={() => arm(o.id)} onKeyDown={(e) => onItemKey(e, o.id)} style={st.item}>
                <span aria-hidden="true">{o.icon} </span>{o.label}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
