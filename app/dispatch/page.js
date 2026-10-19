'use client';

// /dispatch: the owner's loads for management and dispatchers (Marc approved, via Sam, Oct 18 2026).
// Data: public.dispatch_context() + public.dispatch_loads() (SECURITY DEFINER, role-checked in the database).
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import SignInLink from '../components/SignInLink';
import LoadsTabs from '../components/LoadsTabs';
import DispatchHeaderLinks from './DispatchHeaderLinks';
import { Loading, LoadError } from '../components/DataState';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { StatusBadge, fmtMoney, stopSummary } from '../lib/loads';
import { pickupStop, deliveryStop } from '../lib/loadTabs';
import { resolveDispatchAccess, fetchDispatchLoads, SETUP_MSG, driverMap, notMemberCopy, DISPATCH_LOAD_ERROR } from '../lib/dispatch';
import { useRetryWhenOnline, loadWithOneRetry, withTimeout } from '../lib/onlineRetry';
import { fetchDriverChoices } from '../lib/loadDriver';

const s = {
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 820, margin: '0 auto' },
  card: { display: 'block', border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', color: 'inherit', textDecoration: 'none' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  tag: { display: 'inline-block', borderRadius: 999, padding: '0.1rem 0.5rem', fontSize: '0.75rem', fontWeight: 600 },
  link: { color: 'var(--primary)' },
};

export default function DispatchPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState({ status: 'loading' });

  // One pass. → true when it ended in an error state (loadWithOneRetry then tries once more).
  // While the role is unknown the page stays on Loading; it never shows the "not for you" text on a guess (QA #100).
  async function loadOnce({ auto = false } = {}) {
    if (!auto) setState({ status: 'loading' });
    const fail = (text) => { setState({ status: 'error', text }); return true; };
    if (!(await hasSession(supabase))) return fail('Your session has expired or is still loading. Tap Retry, or sign in again.');
    const acc = await resolveDispatchAccess(supabase);
    if (acc.status === 'setup') { setState({ status: 'setup' }); return false; }
    if (acc.status === 'unknown') { console.error('[dispatch] access', acc.error?.code || '', acc.error?.message || ''); return fail(DISPATCH_LOAD_ERROR); }
    if (acc.status === 'not-member') { setState({ status: 'not-member', copy: notMemberCopy(acc.roles) }); return false; }
    const company = acc.companies[0];
    const [res, drv] = await Promise.all([fetchDispatchLoads(supabase), fetchDriverChoices(supabase, company.owner_id)]);
    if (res.setup) { setState({ status: 'setup' }); return false; }
    if (res.error) { console.error('[dispatch] loads', res.error); return fail('Couldn’t load the loads. Check your connection and tap Retry.'); }
    setState({ status: 'ready', company, loads: res.loads.filter((l) => l.owner_id === company.owner_id), drivers: driverMap(drv.choices) });
    return false;
  }
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const load = () => loadWithOneRetry((o) => withTimeout(loadOnce(o), undefined, () => { setState({ status: 'error', text: DISPATCH_LOAD_ERROR }); return true; }), { isLive: () => live.current });
  useRetryWhenOnline(state.status === 'error', () => withTimeout(loadOnce({ auto: true }), undefined, () => true)); // quiet probe: stays on the error until it works

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
      <DispatchHeaderLinks active="loads" />
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to see your company’s loads.</p>
        : state.status === 'loading' ? <Loading label="Loading loads…" />
        : state.status === 'error' ? <LoadError message={state.text} onRetry={load} />
        : state.status === 'setup' ? <p style={s.muted}>{SETUP_MSG}</p>
        : state.status === 'not-member' ? (
          <p style={s.muted} data-testid="dispatch-not-member">{state.copy.text} <Link href={state.copy.href} style={s.link}>{state.copy.linkText}</Link>.</p>
        ) : (
          <>
            <div style={{ ...s.row, margin: '0 0 0.9rem' }}>
              <p style={{ ...s.muted, margin: 0 }}>{state.company.company_name} · {state.company.role === 'management' ? 'Management' : 'Dispatcher'}</p>
              <Link href="/dispatch/new" data-testid="dispatch-new-load" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 14px', borderRadius: 8, background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, textDecoration: 'none' }}>+ New load</Link>
            </div>
            {state.loads.length === 0 ? <p style={s.muted}>No loads yet. Tap New load to create one.</p> : (
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
                      <span><strong>{fmtMoney(l.rate)}</strong>{l.rate_per_mile != null && <span style={{ ...s.muted, color: 'var(--success)', fontWeight: 600 }}> · {fmtMoney(l.rate_per_mile)}/mi</span>}</span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={s.muted}>{drv ? `🚚 ${drv}` : 'No driver'}</span>
                        {l.show_rate_to_driver && <span style={{ ...s.tag, background: 'var(--warning-bg)', color: 'var(--warning)' }}>Rate shown to driver</span>}
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
