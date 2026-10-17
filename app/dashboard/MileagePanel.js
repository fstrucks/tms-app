'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { importedMessage } from '../lib/eldCsv';
import { MILEAGE_VIEW_URL } from '../lib/statsViews';
import SignInLink from '../components/SignInLink';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { Loading, LoadError } from '../components/DataState';
import { MileageForm, EntryRow, sumBy, fmtMiles, todayISO } from '../lib/mileage';

const s = {
  main: { maxWidth: 720 },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  stat: { flex: 1, border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.75rem', textAlign: 'center' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  error: { color: '#b91c1c' },
  link: { color: '#2563eb' },
};

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function weekStartISO() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return iso(d);
}
const monthStartISO = () => todayISO().slice(0, 8) + '01';

// Mileage lives inside Stats (Marc, Oct 17: Truck took Mileage's bottom-nav spot). /mileage redirects here
// (/dashboard?view=mileage), keeping ?imported=… for the ELD import banner. /mileage/import is unchanged.

export default function MileagePanel() {
  const supabase = getSupabase();
  const router = useRouter();
  const [importNote, setImportNote] = useState(null);
  // One-shot banner from the ELD import; strip the params so a reload doesn't repeat it.
  useEffect(() => {
    const m = importedMessage(window.location.search);
    if (m) setImportNote(m);
    if (new URLSearchParams(window.location.search).has('imported')) router.replace(MILEAGE_VIEW_URL, { scroll: false });
  }, []);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const reqRef = useRef(0);
  const readyRef = useRef(false);
  readyRef.current = listState === 'ready';

  async function fetchAll() {
    const req = ++reqRef.current;
    if (!readyRef.current) setListState('loading');
    if (!(await hasSession(supabase))) { if (req === reqRef.current) { if (readyRef.current) setError("Your session has expired or is still loading. Tap Retry, or sign in again."); else setListState('error'); } return; }
    const { data: e, error: ee } = await supabase.from('mileage_entries')
      .select('id, load_id, start_odometer, end_odometer, miles, entry_date, source, notes, created_at, loads(id, broker_load_number, broker_name)')
      .order('entry_date', { ascending: false }).order('created_at', { ascending: false });
    if (req !== reqRef.current) return;
    if (ee) {
      console.error('mileage load', ee);
      if (readyRef.current) return setError("Couldn't refresh. Showing the last loaded mileage.");
      return setListState('error');
    }
    setError(null);
    setEntries(e || []);
    setListState('ready');
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED'].includes(event) || (event === 'TOKEN_REFRESHED' && !readyRef.current)) && u) setTimeout(() => fetchAll(), 0);
      if (event === 'SIGNED_OUT') { reqRef.current++; setEntries([]); setListState('loading'); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function add(r) {
    const res = await supabase.from('mileage_entries').insert({ ...r, user_id: user.id });
    if (!res.error) fetchAll();
    return res;
  }

  async function remove(e) {
    const { error } = await supabase.from('mileage_entries').delete().eq('id', e.id);
    if (error) { console.error('mileage delete', error); return setError('Could not delete, please try again.'); }
    fetchAll();
  }

  // Totals only count entries dated today or earlier (future-dated entries are excluded).
  const today = todayISO();
  const week = weekStartISO();
  const month = monthStartISO();
  const inRange = (from) => (e) => e.entry_date >= from && e.entry_date <= today && Number(e.miles) > 0;
  const weekMiles = sumBy(entries, inRange(week));
  const monthMiles = sumBy(entries, inRange(month));
  const weekLoaded = sumBy(entries, (e) => inRange(week)(e) && e.source === 'loaded');
  const monthLoaded = sumBy(entries, (e) => inRange(month)(e) && e.source === 'loaded');

  return (
    <section style={s.main} data-testid="mileage-panel" aria-label="Mileage">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', margin: '0.5rem 0' }}>Mileage</h2>
        {user && <Link href="/mileage/import" style={{ ...s.link, fontSize: '0.95rem', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>Import ELD CSV</Link>}
      </div>
      {importNote && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', borderRadius: 10, padding: '0.4rem 0.4rem 0.4rem 0.75rem', marginBottom: '0.75rem' }}>
          <span>{importNote}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setImportNote(null)}
            style={{ background: 'none', border: 'none', color: '#166534', fontSize: '1.2rem', minWidth: 44, minHeight: 44 }}>×</button>
        </div>
      )}
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to track mileage.</p>
        : (
          <>
            {error && listState === 'ready' && <LoadError subtle message={error} onRetry={() => { setError(null); fetchAll(); }} />}
            {error && listState !== 'ready' && <p style={s.error}>{error}</p>}
            {listState === 'error' && <LoadError message="Couldn't load your mileage." onRetry={fetchAll} />}
            {listState === 'ready' && (
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div style={s.stat}><div style={s.muted}>This week</div><strong style={{ fontSize: '1.2rem' }}>{fmtMiles(weekMiles)}</strong><div style={s.muted}>{fmtMiles(weekLoaded)} loaded</div></div>
              <div style={s.stat}><div style={s.muted}>This month</div><strong style={{ fontSize: '1.2rem' }}>{fmtMiles(monthMiles)}</strong><div style={s.muted}>{fmtMiles(monthLoaded)} loaded</div></div>
            </div>
            )}
            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Add miles</h2>
              <MileageForm onSubmit={add} pickLoad />
            </div>
            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Entries</h2>
              {listState === 'loading' ? <Loading label="Loading mileage…" />
                : listState === 'error' ? <p style={s.muted}>Entries will appear here once mileage loads.</p>
                : entries.length === 0 ? <p style={s.muted}>No entries yet.</p> : entries.map((e) => (
                <EntryRow key={e.id} e={e} onDelete={remove} loadLink={e.load_id ? (
                  <Link href={`/loads/${e.load_id}`} style={{ ...s.link, fontSize: '0.8rem' }}>
                    {e.loads?.broker_load_number ? `Load #${e.loads.broker_load_number}` : 'View load'}{e.loads?.broker_name ? ` · ${e.loads.broker_name}` : ''}
                  </Link>
                ) : null} />
              ))}
            </div>
          </>
        )}
    </section>
  );
}
