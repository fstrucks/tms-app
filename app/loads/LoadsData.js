'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { StatusBadge, fmtMoney, stopSummary } from '../lib/loads';
import { Loading, LoadError } from '../components/DataState';
import SignInLink from '../components/SignInLink';
import LoadsTabs from '../components/LoadsTabs';
import { pickupStop, deliveryStop } from '../lib/loadTabs';

// One fetch of the loads list, shared by the /loads page (all widths) and the desktop list pane
// shown next to /loads/[id] at >= 1024px (pick 2A). Fetch/auth behaviour is unchanged from the old page.
const Ctx = createContext(null);
export const useLoads = () => useContext(Ctx);

const s = {
  card: { display: 'block', border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', color: 'inherit', textDecoration: 'none' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  error: { color: 'var(--danger)' },
  link: { color: 'var(--primary)' },
};

export function LoadsProvider({ children }) {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [loads, setLoads] = useState([]);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false); // true once a fetch finished without error
  const reqRef = useRef(0);
  const loadedRef = useRef(false);
  loadedRef.current = loaded;

  async function loadLoads() {
    const req = ++reqRef.current;
    // After data has loaded, failures keep the list and show a non-blocking banner (like /documents, /mileage).
    const fail = (msg) => setError(loadedRef.current ? { subtle: true, text: `Couldn't refresh. Showing the last loaded loads. ${msg}` } : { subtle: false, text: msg });
    if (!(await hasSession(supabase))) { if (req === reqRef.current) fail("Your session has expired or is still loading. Tap Retry, or sign in again."); return; }
    const { data, error } = await supabase
      .from('loads')
      .select('id, status, broker_name, broker_load_number, rate, rate_per_mile, total_miles, created_at, stops(sequence, stop_type, company_name, city, state, appointment_start, timezone)')
      .order('created_at', { ascending: false });
    if (req !== reqRef.current) return; // a newer fetch (e.g. after sign-in) superseded this one
    if (error) { console.error('[loads] fetch', error); return fail("Couldn't load your loads."); }
    setError(null);
    setLoads(data || []);
    setLoaded(true);
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      // Fetch only once a session exists; re-fetch whenever the session changes.
      if (['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event) && u && (event !== 'TOKEN_REFRESHED' || !loadedRef.current)) setTimeout(() => loadLoads(), 0);
      if (event === 'SIGNED_OUT') { reqRef.current++; setLoads([]); setLoaded(false); setError(null); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Optimistic patch from the detail pane (e.g. status change) so the list stays in sync.
  const patchLoad = (id, patch) => setLoads((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  return <Ctx.Provider value={{ user, checking, loads, error, loaded, reload: loadLoads, patchLoad }}>{children}</Ctx.Provider>;
}

export function LoadsList({ selectedId = null }) {
  const { user, checking, loads, error, loaded, reload } = useLoads();
  if (supabaseConfigError) return <p style={s.error}>{supabaseConfigError}</p>;
  if (checking) return <p style={s.muted}>Checking sign-in…</p>;
  if (!user) return <p>Please <SignInLink style={s.link}>sign in</SignInLink> to see your loads.</p>;
  return (
    <>
      {error && <LoadError message={error.text} subtle={error.subtle} onRetry={reload} />}
      {!loaded && !error && <Loading label="Loading loads…" />}
      {loaded && loads.length === 0 && !error && (
        <p style={s.muted}>No loads yet. Upload a rate confirmation on <Link href="/documents" style={s.link}>Documents</Link> and tap "Create load".</p>
      )}
      {loaded && loads.length > 0 && <LoadsTabs loads={loads} renderLoad={(l) => {
        const stops = [pickupStop(l), deliveryStop(l)];
        const sel = l.id === selectedId;
        return (
          <Link key={l.id} href={`/loads/${l.id}`} aria-current={sel ? 'page' : undefined}
            style={{ ...s.card, ...(sel ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 1px var(--primary)', background: 'var(--info-bg)' } : null) }}>
            <div style={s.row}>
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.broker_load_number ? `#${l.broker_load_number}` : 'Load'}{l.broker_name ? ` · ${l.broker_name}` : ''}
              </strong>
              {/* TODO(pick 5, open): status colours. Current StatusBadge kept until Marc decides. */}
              <StatusBadge status={l.status} />
            </div>
            <div style={{ margin: '0.4rem 0', fontSize: '0.9rem' }}>
              {stopSummary(stops[0])} <span style={s.muted}>→</span> {stopSummary(stops[stops.length - 1])}
            </div>
            <div style={s.row}>
              <span><strong>{fmtMoney(l.rate)}</strong>{l.total_miles > 0 && <span style={s.muted}> · {Number(l.total_miles).toLocaleString('en-US')} mi</span>}{l.rate_per_mile != null && <span style={{ ...s.muted, fontWeight: 600, color: 'var(--success)' }}> · {fmtMoney(l.rate_per_mile)}/mi</span>}</span>
              <span style={s.muted}>{new Date(l.created_at).toLocaleDateString()}</span>
            </div>
          </Link>
        );
      }} />}
    </>
  );
}
