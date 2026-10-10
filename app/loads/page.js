'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { StatusBadge, fmtMoney, stopSummary } from '../lib/loads';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
  card: { display: 'block', border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', color: 'inherit', textDecoration: 'none' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  error: { color: '#b91c1c' },
  link: { color: '#2563eb' },
};

export default function LoadsPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [loads, setLoads] = useState([]);
  const [error, setError] = useState(null);

  async function loadLoads() {
    const { data, error } = await supabase
      .from('loads')
      .select('id, status, broker_name, broker_load_number, rate, rate_per_mile, created_at, stops(sequence, stop_type, company_name, city, state, appointment_start)')
      .order('created_at', { ascending: false });
    if (error) return setError('Could not load loads: ' + error.message);
    setLoads(data || []);
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && u) setTimeout(() => loadLoads(), 0);
      if (event === 'SIGNED_OUT') setLoads([]);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <main style={s.main}>
      <p style={{ display: 'flex', gap: '1rem' }}>
        <Link href="/" style={s.link}>← Home</Link>
        <Link href="/documents" style={s.link}>Documents</Link>
      </p>
      <h1 style={{ fontSize: '1.5rem' }}>Loads</h1>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <Link href="/login" style={s.link}>sign in</Link> to see your loads.</p>
        : (
          <>
            {error && <p style={s.error}>{error}</p>}
            {loads.length === 0 && !error && (
              <p style={s.muted}>No loads yet. Upload a rate confirmation on <Link href="/documents" style={s.link}>Documents</Link> and tap "Create load".</p>
            )}
            {loads.map((l) => {
              const stops = [...(l.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
              return (
                <Link key={l.id} href={`/loads/${l.id}`} style={s.card}>
                  <div style={s.row}>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.broker_load_number ? `#${l.broker_load_number}` : 'Load'}{l.broker_name ? ` · ${l.broker_name}` : ''}
                    </strong>
                    <StatusBadge status={l.status} />
                  </div>
                  <div style={{ margin: '0.4rem 0', fontSize: '0.9rem' }}>
                    {stopSummary(stops[0])} <span style={s.muted}>→</span> {stopSummary(stops[stops.length - 1])}
                  </div>
                  <div style={s.row}>
                    <span><strong>{fmtMoney(l.rate)}</strong>{l.rate_per_mile != null && <span style={s.muted}> · {fmtMoney(l.rate_per_mile)}/mi</span>}</span>
                    <span style={s.muted}>{new Date(l.created_at).toLocaleDateString()}</span>
                  </div>
                </Link>
              );
            })}
          </>
        )}
    </main>
  );
}
