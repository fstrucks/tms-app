'use client';
// Links under the Dispatch / Load boards headings: Loads (/dispatch) and Load boards (/dispatch/boards).
import Link from 'next/link';

export default function DispatchHeaderLinks({ active = 'loads' }) {
  const a = (on) => ({ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 2px', color: on ? 'var(--text)' : 'var(--primary)', fontWeight: on ? 700 : 500, textDecoration: on ? 'none' : 'underline' });
  return (
    <nav aria-label="Dispatch sections" style={{ display: 'flex', gap: 16, margin: '0 0 0.5rem' }} data-testid="dispatch-header-links">
      <Link href="/dispatch" style={a(active === 'loads')} aria-current={active === 'loads' ? 'page' : undefined}>Loads</Link>
      <Link href="/dispatch/boards" style={a(active === 'boards')} aria-current={active === 'boards' ? 'page' : undefined}>Load boards</Link>
    </nav>
  );
}
