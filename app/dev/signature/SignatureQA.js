'use client';

import { useState } from 'react';
import SignaturePad from '../../components/SignaturePad';

export default function SignatureQA() {
  const [result, setResult] = useState(null);
  const [cancelled, setCancelled] = useState(false);
  return (
    <main style={{ padding: '1rem', maxWidth: 680, margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 20 }}>Signature pad QA (dev only)</h1>
      <SignaturePad onDone={(r) => { setResult(r); setCancelled(false); }} onCancel={() => { setCancelled(true); setResult(null); }} />
      {cancelled && <p role="status" style={{ marginTop: '1rem', fontWeight: 600 }}>Cancelled</p>}
      {result && (
        <div style={{ marginTop: '1rem', fontSize: 14, lineHeight: 1.6 }}>
          <div>method: <b>{result.method}</b></div>
          <div>signerName: <b>{result.signerName}</b></div>
          <div>signedAt: <b>{result.signedAt}</b></div>
          <div>dataUrl length: {result.dataUrl.length}</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={result.dataUrl} alt="Signature result" style={{ maxWidth: '100%', marginTop: 8, border: '1px solid #e5e7eb', background: 'repeating-conic-gradient(#f3f4f6 0 25%, #fff 0 50%) 0 0 / 16px 16px' }} />
        </div>
      )}
    </main>
  );
}
