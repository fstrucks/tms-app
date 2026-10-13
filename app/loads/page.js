'use client';

import { useEffect, useState } from 'react';
import { LoadsList } from './LoadsData';

const main = { padding: '1rem', fontFamily: 'system-ui', maxWidth: 1120, margin: '0 auto' };

// /loads: the list at every width. On desktop, picking a load opens /loads/[id], where the list
// stays on the left and the detail shows on the right (see ./layout.js).
export default function LoadsPage() {
  const [notice, setNotice] = useState(null); // e.g. from a load delete whose file removal failed
  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get('notice');
    if (n) { setNotice(n); window.history.replaceState(null, '', '/loads'); }
  }, []);
  return (
    <main style={main}>
      <h1 style={{ fontSize: '1.5rem' }}>Loads</h1>
      {notice && <p role="status" style={{ background: '#fef3c7', color: '#92400e', borderRadius: 8, padding: '0.6rem 0.8rem' }}>{notice}</p>}
      <LoadsList />
    </main>
  );
}
