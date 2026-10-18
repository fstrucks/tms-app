'use client';
// Account menu item "Bug reports", shown only to company owners. Who is an owner is decided once by AccountMenu
// (lib/accountOwner: own company_profiles row, RLS read) and passed in, so this and Invite testers always agree.
// The page/API enforce access server-side; this only hides the link from everyone else.
import Link from 'next/link';

export default function BugReportsMenuItem({ owner, onPick }) {
  if (!owner) return null;
  return (
    <Link href="/bug-reports" role="menuitem" onClick={onPick} data-testid="menu-bug-reports"
      style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', borderRadius: 8, color: '#111827', textDecoration: 'none' }}>
      Bug reports
    </Link>
  );
}
