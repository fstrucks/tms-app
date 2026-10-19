'use client';

// /dispatch: the owner's loads for management and dispatchers (Marc approved, via Sam, Oct 18 2026).
// Data: public.dispatch_context() + public.dispatch_loads() (SECURITY DEFINER, role-checked in the database).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import SignInLink from '../components/SignInLink';
import LoadsTabs from '../components/LoadsTabs';
import { Loading, LoadError } from '../components/DataState';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { StatusBadge, fmtMoney, stopSummary } from '../lib/loads';
import { pickupStop, deliveryStop } from '../lib/loadTabs';
import { fetchDispatchContext, fetchDispatchLoads, SETUP_MSG, driverMap, notMemberCopy, fetchMyRoles } from '../lib/dispatch';
import { fetchDriverChoices } from '../lib/loadDriver';

const s = {
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 820, margin: '0 auto' },
  card: { display: 'block', border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', color: 'inherit', textDecoration: 'none' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  tag: { display: 'inline-block', borderRadius: 999, padding: '0.1rem 0.5rem', fontSize: '0.75rem', fontWeight: 600 },
  link: { color: '#2563eb' },
};

export default function DispatchPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState({ status: 'loading' });

  async function load() {
    setState({ status: 'loading' });
    if (!(await hasSession(supabase))) return setState({ status: 'error', text: 'Your session has expired or is still loading. Tap Retry, or sign in again.' });
    const ctx = await fetchDispatchContext(supabase);
    if (ctx.setup) return setState({ status: 'setup' });
    if (ctx.error) { console.error('[dispatch] context', ctx.error); return setState({ status: 'error', text: 'Couldn’t load the dispatch center.' }); }
    if (!ctx.companies.length) return setState({ status: 'not-member', copy: notMemberCopy(await fetchMyRoles(supabase)) });
    const company = ctx.companies[0];
    const [res, drv] = await Promise.all([fetchDispatchLoads(supabase), fetchDriverChoices(supabase, company.owner_id)]);
    if (res.error || res.setup) { console.error('[dispatch] loads', res.error); return setState({ status: res.setup ? 'setup' : 'error', text: 'Couldn’t load the loads.' }); }
    setState({ status: 'ready', company, loads: res.loads.filter((l) => l.owner_id === company.owner_id), drivers: driverMap(drv.choices) });
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && u) setTimeout(() => load(), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0 0.25rem' }}>Dispatch</h1>
      {supabaseConfigError ? <p style={{ color: '#b91c1c' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to see your company’s loads.</p>
        : state.status === 'loading' ? <Loading label="Loading loads…" />
        : state.status === 'error' ? <LoadError message={state.text} onRetry={load} />
        : state.status === 'setup' ? <p style={s.muted}>{SETUP_MSG}</p>
        : state.status === 'not-member' ? (
          <p style={s.muted} data-testid="dispatch-not-member">{state.copy.text} <Link href={state.copy.href} style={s.link}>{state.copy.linkText}</Link>.</p>
        ) : (
          <>
            <p style={{ ...s.muted, margin: '0 0 0.9rem' }}>{state.company.company_name} · {state.company.role === 'management' ? 'Management' : 'Dispatcher'}</p>
            {state.loads.length === 0 ? <p style={s.muted}>No loads yet. The owner creates loads from a rate con or with New load.</p> : (
              <LoadsTabs loads={state.loads} hrefFor={(id) => `/dispatch/${id}`} renderLoad={(l) => {
                const drv = l.assigned_driver_user_id ? (state.drivers[l.assigned_driver_user_id] || 'Driver (no longer on the company)') : null;
                return (
                  <Link key={l.id} href={`/dispatch/${l.id}`} style={s.card} data-testid="dispatch-load">
                    <div style={s.row}>
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.broker_load_number ? `#${l.broker_load_number}` : 'Load'}{l.broker_name ? ` · ${l.broker_name}` : ''}
                      </strong>
                      <StatusBadge status={l.status} />
                    </div>
                    <div style={{ margin: '0.4rem 0', fontSize: '0.9rem' }}>{stopSummary(pickupStop(l))} <span style={s.muted}>→</span> {stopSummary(deliveryStop(l))}{l.stops?.length > 2 && <span style={s.muted}> · {l.stops.length} stops</span>}</div>
                    <div style={s.row}>
                      <span><strong>{fmtMoney(l.rate)}</strong>{l.rate_per_mile != null && <span style={{ ...s.muted, color: '#065f46', fontWeight: 600 }}> · {fmtMoney(l.rate_per_mile)}/mi</span>}</span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={s.muted}>{drv ? `🚚 ${drv}` : 'No driver'}</span>
                        {l.show_rate_to_driver && <span style={{ ...s.tag, background: '#fef3c7', color: '#92400e' }}>Rate shown to driver</span>}
                      </span>
                    </div>
                  </Link>
                );
              }} />
            )}
          </>
        )}
    </main>
  );
}
