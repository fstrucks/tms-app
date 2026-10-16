'use client';
// TEMPORARY stand-in for SignaturePad (#61) with the same props and onDone shape, so packet signing can
// be built and tested now. Type-only, plain canvas. Delete once PacketSignaturePad.js points at the real pad.
import { useState } from 'react';

export function typedSignaturePng(name, doc = document) {
  const c = doc.createElement('canvas'); c.width = 600; c.height = 140;
  const g = c.getContext('2d'); g.font = 'italic 56px cursive'; g.fillStyle = '#111827'; g.textBaseline = 'middle';
  g.fillText(name, 12, 70, 576);
  return c.toDataURL('image/png');
}

export default function SignaturePadStub({ onDone, onCancel, initialName = '', title = 'Sign here' }) {
  const [name, setName] = useState(initialName);
  const ok = name.trim().length > 0;
  const btn = { minHeight: 44, padding: '0 1rem', borderRadius: 10, fontSize: 16, fontWeight: 600 };
  return (
    <section aria-label={title} style={{ border: '2px solid #059669', borderRadius: 12, padding: '0.75rem', margin: '0.75rem 0', background: '#f0fdf4' }}>
      <strong>{title}</strong>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0.25rem 0' }}>Temporary typed signature (draw pad coming in #61).</p>
      <input aria-label="Signer name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name"
        style={{ width: '100%', minHeight: 44, fontSize: 16, boxSizing: 'border-box', padding: '0 0.6rem', borderRadius: 8, border: '1px solid #d1d5db' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {onCancel && <button style={{ ...btn, border: '1px solid #d1d5db', background: '#fff' }} onClick={onCancel}>Cancel</button>}
        <button style={{ ...btn, flex: 1, border: 0, background: '#059669', color: '#fff', opacity: ok ? 1 : 0.5 }} disabled={!ok}
          onClick={() => onDone({ dataUrl: typedSignaturePng(name.trim()), signerName: name.trim(), signedAt: new Date().toISOString(), method: 'type' })}>Sign</button>
      </div>
    </section>
  );
}
