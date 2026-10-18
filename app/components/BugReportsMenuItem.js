'use client';
// Account menu item "Bug reports", shown only to company owners (owns a company_profiles row; own-row RLS read).
// The page/API enforce access server-side; this only hides the link from everyone else.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';

export default function BugReportsMenuItem({ userId, onPick }) {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    const sb = getSupabase(); if (!sb || !userId) return undefined;
    let alive = true;
    sb.from('company_profiles').select('id').eq('owner_id', userId).limit(1)
      .then(({ data }) => { if (alive) setOwner(!!data?.length); }, () => {});
    return () => { alive = false; };
  }, [userId]);
  if (!owner) return null;
  return (
    <Link href="/bug-reports" role="menuitem" onClick={onPick} data-testid="menu-bug-reports"
      style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.8rem', fontSize: '1rem', borderRadius: 8, color: '#111827', textDecoration: 'none' }}>
      Bug reports
    </Link>
  );
}
