'use client';
// Links under the Dispatch / Load boards headings: Loads and Load boards (/dispatch/boards). Owners are gated out of
// /dispatch, so their Loads link goes to /loads (loadsLinkHref).
import Link from 'next/link';
import { loadsLinkHref } from '../lib/loadBoards';

export default function DispatchHeaderLinks({ active = 'loads', role }) {
  const a = (on) => ({ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 2px', color: on ? 'var(--text)' : 'var(--primary)', fontWeight: on ? 700 : 500, textDecoration: on ? 'none' : 'underline' });
  // On /dispatch the Loads link is the current page. Elsewhere it stays a same-looking, non-clickable label until the
  // role resolves, so an early click (or no JavaScript) never sends an owner to the /dispatch gate.
  const loadsHref = active === 'loads' ? '/dispatch' : loadsLinkHref(role);
  return (
    <nav aria-label="Dispatch sections" style={{ display: 'flex', gap: 16, margin: '0 0 0.5rem' }} data-testid="dispatch-header-links">
      {loadsHref
        ? <Link href={loadsHref} style={a(active === 'loads')} aria-current={active === 'loads' ? 'page' : undefined}>Loads</Link>
        : <span role="link" aria-disabled="true" style={{ ...a(false), cursor: 'default' }} data-testid="dispatch-loads-pending">Loads</span>}
      <Link href="/dispatch/boards" style={a(active === 'boards')} aria-current={active === 'boards' ? 'page' : undefined}>Load boards</Link>
    </nav>
  );
}
