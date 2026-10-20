'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';

// Loads: "N rate cons from email are waiting for review" → Documents. Hidden when there are none, or before
// migration 20261019000200 (the query errors and we show nothing).
export default function EmailDraftsBanner() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const sb = getSupabase(); if (!sb) return;
    let live = true;
    sb.from('documents').select('id', { count: 'exact', head: true }).eq('source', 'email').is('load_id', null).eq('doc_type', 'rate_confirmation')
      .or('extraction_error.is.null,extraction_error.neq.not_ratecon') // not-a-rate-con PDFs don't count
      .then(({ count, error }) => { if (live && !error) setN(count || 0); });
    return () => { live = false; };
  }, []);
  if (!n) return null;
  return (
    <p role="status" data-testid="email-drafts-banner" style={{ background: 'var(--info-bg)', color: 'var(--text)', borderRadius: 8, padding: '0.6rem 0.8rem' }}>
      <span style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--primary)', color: 'var(--on-primary)', marginRight: 8 }}>From email</span>
      {n === 1 ? '1 rate con is' : `${n} rate cons are`} waiting for review. <Link href="/documents" style={{ color: 'var(--primary)', fontWeight: 600 }}>Review on Documents</Link>
    </p>
  );
}
