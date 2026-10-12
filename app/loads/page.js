'use client';

import { LoadsList } from './LoadsData';

const main = { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' };

// /loads: the list at every width. On desktop, picking a load opens /loads/[id], where the list
// stays on the left and the detail shows on the right (see ./layout.js).
export default function LoadsPage() {
  return (
    <main style={main}>
      <h1 style={{ fontSize: '1.5rem' }}>Loads</h1>
      <LoadsList />
    </main>
  );
}
