'use client';

import { useEffect, useRef, useState } from 'react';

// Inline two-step confirm (pick 4A): first click swaps the button for "Confirm" / "Cancel" in the
// same row, with no modal. Focus moves to Cancel (the safe choice); Esc cancels.
// After Confirm: on failure (onConfirm throws or returns false) focus returns to the trigger.
// On success, focus goes to onDone's returned element if given, otherwise to the next row's first
// focusable element (nearest [data-confirm-row] / li / tr sibling), otherwise the trigger if still mounted.
// The group wraps on narrow rows; the visible prompt is hidden below 640px (aria-label keeps it).
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function nextRowTarget(el) {
  const row = el?.closest?.('[data-confirm-row], li, tr');
  let sib = row?.nextElementSibling;
  while (sib) { const f = sib.matches(FOCUSABLE) ? sib : sib.querySelector(FOCUSABLE); if (f) return f; sib = sib.nextElementSibling; }
  sib = row?.previousElementSibling;
  while (sib) { const f = sib.matches(FOCUSABLE) ? sib : sib.querySelector(FOCUSABLE); if (f) return f; sib = sib.previousElementSibling; }
  return null;
}

export default function ConfirmButton({ label = 'Delete', confirmLabel = 'Confirm', prompt, ariaLabel, onConfirm, onDone, danger = true, disabled = false }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // double-click guard independent of render timing
  const cancelRef = useRef(null);
  const triggerRef = useRef(null);
  const groupRef = useRef(null);
  const focusAfter = useRef(null); // 'trigger' | Element | null

  useEffect(() => { if (asking) cancelRef.current?.focus(); }, [asking]);
  useEffect(() => {
    if (asking || !focusAfter.current) return;
    const t = focusAfter.current; focusAfter.current = null;
    const el = t === 'trigger' ? triggerRef.current : t;
    if (el && el.isConnected) el.focus(); else triggerRef.current?.focus();
  }, [asking]);

  const red = { border: '1px solid var(--danger-border)', color: 'var(--danger)', background: 'var(--surface)' };
  const base = { minHeight: 44, minWidth: 44, padding: '0 0.8rem', borderRadius: 8, fontSize: '0.9rem', cursor: 'pointer' };
  const cancel = () => { focusAfter.current = 'trigger'; setAsking(false); };

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const nextEl = nextRowTarget(groupRef.current);
    let ok = true;
    try { const r = await onConfirm?.(); if (r === false) ok = false; } catch (e) { ok = false; console.error('[confirm]', e); }
    if (ok) {
      let target = null;
      try { target = onDone?.() || null; } catch (e) { console.error('[confirm] onDone', e); }
      focusAfter.current = target || nextEl || 'trigger';
    } else focusAfter.current = 'trigger';
    busyRef.current = false; setBusy(false); setAsking(false);
    // If the row unmounted on success, the effect above won't run; focus directly as a fallback.
    setTimeout(() => {
      const t = focusAfter.current; if (!t) return; focusAfter.current = null;
      const el = t === 'trigger' ? triggerRef.current : t;
      if (el && el.isConnected) el.focus();
    }, 0);
  }

  if (!asking) {
    return <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setAsking(true)} style={{ ...base, ...(danger ? red : { border: '1px solid var(--border)', background: 'var(--surface)' }) }}>{label}</button>;
  }
  return (
    <span ref={groupRef} role="group" className="confirm-group" aria-label={ariaLabel || prompt || `${label}?`} style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, maxWidth: '100%' }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}>
      {prompt && <span className="confirm-prompt" aria-hidden="true" style={{ fontSize: '0.9rem', color: 'var(--text)' }}>{prompt}</span>}
      <button type="button" disabled={busy} onClick={confirm}
        style={{ ...base, border: 'none', background: danger ? 'var(--danger-solid)' : 'var(--primary)', color: danger ? 'var(--on-danger)' : 'var(--on-primary)' }}>{busy ? '…' : confirmLabel}</button>
      <button ref={cancelRef} type="button" disabled={busy} onClick={cancel} style={{ ...base, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>Cancel</button>
    </span>
  );
}
