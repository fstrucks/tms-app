'use client';

import { useEffect, useRef, useState } from 'react';

// Inline two-step confirm (pick 4A): first click swaps the button for "Confirm" / "Cancel" in the
// same row, with no modal. Focus moves to Cancel (the safe choice); Esc cancels. Not wired into
// Expenses/Mileage here (Casey's area); they can adopt it in place of window.confirm.
export default function ConfirmButton({ label = 'Delete', confirmLabel = 'Confirm', prompt, onConfirm, danger = true, disabled = false }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => { if (asking) cancelRef.current?.focus(); }, [asking]);

  const red = { border: '1px solid #fecaca', color: '#b91c1c', background: '#fff' };
  const base = { minHeight: 44, minWidth: 44, padding: '0 0.8rem', borderRadius: 8, fontSize: '0.9rem', cursor: 'pointer' };
  const cancel = () => { setAsking(false); setTimeout(() => triggerRef.current?.focus(), 0); };

  if (!asking) {
    return <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setAsking(true)} style={{ ...base, ...(danger ? red : { border: '1px solid #d1d5db', background: '#fff' }) }}>{label}</button>;
  }
  return (
    <span role="group" aria-label={prompt || `${label}?`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}>
      {prompt && <span style={{ fontSize: '0.9rem', color: '#374151' }}>{prompt}</span>}
      <button type="button" disabled={busy}
        onClick={async () => { setBusy(true); try { await onConfirm?.(); } finally { setBusy(false); setAsking(false); } }}
        style={{ ...base, border: 'none', background: danger ? '#b91c1c' : '#2563eb', color: '#fff' }}>{busy ? '…' : confirmLabel}</button>
      <button ref={cancelRef} type="button" disabled={busy} onClick={cancel} style={{ ...base, border: '1px solid #d1d5db', background: '#fff', color: '#111827' }}>Cancel</button>
    </span>
  );
}
