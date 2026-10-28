'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getSupabase } from '../lib/supabase';
import { formatWhen } from '../lib/accountDeletion';
import { isPublicLegalPath } from '../lib/legalRoutes';

// Shown while a company deletion is waiting, and once when signing in cancels it.
export default function DeletionBanner() {
  const pathname = usePathname() || '/';
  const [note, setNote] = useState(null);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return undefined;
    let live = true;
    async function pull(session) {
      const access = session?.access_token;
      if (!access) { if (live) setNote(null); return; }
      try {
        const res = await fetch('/api/account/deletion', { headers: { authorization: `Bearer ${access}` }, cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!live || !res.ok) return;
        if (body.cancelled && body.message) setNote({ tone: 'ok', text: body.message });
        else if (body.pending?.purge_after) setNote({ tone: 'pending', text: `This company is scheduled to be deleted on ${formatWhen(body.pending.purge_after)}. Sign in again before that date to cancel it, or cancel from Settings.` });
        else setNote(null);
      } catch { /* leave the last note */ }
    }
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => { pull(session); });
    sb.auth.getSession().then(({ data }) => pull(data?.session)).catch(() => {});
    return () => { live = false; sub.subscription.unsubscribe(); };
  }, [pathname]);

  if (!note || isPublicLegalPath(pathname)) return null;
  const pending = note.tone === 'pending';
  return (
    <div role="status" data-testid="deletion-banner" style={{
      margin: '0.75rem 1rem 0',
      padding: '0.75rem 1rem',
      borderRadius: 12,
      background: pending ? 'var(--danger-bg)' : 'var(--surface-2)',
      border: `1px solid ${pending ? 'var(--danger-border)' : 'var(--divider)'}`,
      color: 'var(--text)',
      fontFamily: 'system-ui',
    }}>
      {note.text}
    </div>
  );
}
