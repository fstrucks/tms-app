'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>Loads</h1>
        <Link href="/loads/new" data-testid="new-load-link" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', padding: '0 14px', borderRadius: 8, background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, textDecoration: 'none' }}>+ New load</Link>
      </div>
      {notice && <p role="status" style={{ background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 8, padding: '0.6rem 0.8rem' }}>{notice}</p>}
      <LoadsList />
    </main>
  );
}
