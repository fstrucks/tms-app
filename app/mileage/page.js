'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { MileageForm, EntryRow, sumBy, fmtMiles, todayISO } from '../lib/mileage';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
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

export default function MileagePage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [entries, setEntries] = useState([]);
  const [loads, setLoads] = useState([]);
  const [error, setError] = useState(null);

  async function fetchAll() {
    const [{ data: e, error: ee }, { data: l }] = await Promise.all([
      supabase.from('mileage_entries')
        .select('id, load_id, start_odometer, end_odometer, miles, entry_date, source, notes, created_at, loads(id, broker_load_number, broker_name)')
        .order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('loads').select('id, broker_load_number, broker_name, created_at').order('created_at', { ascending: false }).limit(50),
    ]);
    if (ee) return setError('Could not load mileage: ' + ee.message);
    setEntries(e || []);
    setLoads((l || []).map((x) => ({ id: x.id, label: [x.broker_load_number && `#${x.broker_load_number}`, x.broker_name].filter(Boolean).join(' · ') || `Load ${new Date(x.created_at).toLocaleDateString()}` })));
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && u) setTimeout(() => fetchAll(), 0);
      if (event === 'SIGNED_OUT') { setEntries([]); setLoads([]); }
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

  const week = weekStartISO();
  const month = monthStartISO();
  const weekMiles = sumBy(entries, (e) => e.entry_date >= week);
  const monthMiles = sumBy(entries, (e) => e.entry_date >= month);
  const weekLoaded = sumBy(entries, (e) => e.entry_date >= week && e.source === 'loaded');
  const monthLoaded = sumBy(entries, (e) => e.entry_date >= month && e.source === 'loaded');

  return (
    <main style={s.main}>
      <p style={{ display: 'flex', gap: '1rem' }}>
        <Link href="/" style={s.link}>← Home</Link>
        <Link href="/loads" style={s.link}>Loads</Link>
      </p>
      <h1 style={{ fontSize: '1.5rem' }}>Mileage</h1>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <Link href="/login" style={s.link}>sign in</Link> to track mileage.</p>
        : (
          <>
            {error && <p style={s.error}>{error}</p>}
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div style={s.stat}><div style={s.muted}>This week</div><strong style={{ fontSize: '1.2rem' }}>{fmtMiles(weekMiles)}</strong><div style={s.muted}>{fmtMiles(weekLoaded)} loaded</div></div>
              <div style={s.stat}><div style={s.muted}>This month</div><strong style={{ fontSize: '1.2rem' }}>{fmtMiles(monthMiles)}</strong><div style={s.muted}>{fmtMiles(monthLoaded)} loaded</div></div>
            </div>
            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Add miles</h2>
              <MileageForm onSubmit={add} loads={loads} />
            </div>
            <div style={s.card}>
              <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Entries</h2>
              {entries.length === 0 ? <p style={s.muted}>No entries yet.</p> : entries.map((e) => (
                <EntryRow key={e.id} e={e} onDelete={remove} loadLink={e.load_id ? (
                  <Link href={`/loads/${e.load_id}`} style={{ ...s.link, fontSize: '0.8rem' }}>
                    {e.loads?.broker_load_number ? `Load #${e.loads.broker_load_number}` : 'View load'}{e.loads?.broker_name ? ` · ${e.loads.broker_name}` : ''}
                  </Link>
                ) : null} />
              ))}
            </div>
          </>
        )}
    </main>
  );
}
