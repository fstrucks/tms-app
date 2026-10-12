'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import LoadMileage from '../../components/LoadMileage';
import LoadExpenses from '../../components/LoadExpenses';
import { Loading, LoadError } from '../../components/DataState';
import { useLoads } from '../LoadsData';
import { STATUSES, StatusBadge, fmtMoney, fmtNumber, fmtApptWindow, fullAddress } from '../../lib/loads';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  error: { color: '#b91c1c' },
  link: { color: '#2563eb' },
  btn: { minHeight: 44, minWidth: 64, padding: '0.5rem 0.9rem', fontSize: '0.9rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff' },
  dl: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 0.75rem', margin: 0, fontSize: '0.9rem' },
};

export default function LoadDetailPage() {
  const { id } = useParams();
  const supabase = getSupabase();
  const list = useLoads(); // shared list (desktop left pane); kept in sync on status change
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [load, setLoad] = useState(null);
  const [docs, setDocs] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function fetchAll() {
    setError(null);
    if (!(await hasSession(supabase))) return setError({ retry: true, text: "Your session has expired or is still loading. Tap Retry, or sign in again." });
    const [{ data: l, error: le }, { data: d, error: de }] = await Promise.all([
      supabase.from('loads').select('*, stops(*)').eq('id', id).maybeSingle(),
      supabase.from('documents').select('id, doc_type, file_path, original_filename, created_at').eq('load_id', id).order('created_at', { ascending: false }),
    ]);
    if (le) { console.error('[load] fetch', le); return setError({ retry: true, text: "Couldn't load this load." }); }
    if (!l) return setError({ retry: false, text: 'Load not found.' });
    l.stops = [...(l.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    setLoad(l);
    if (de) { console.error('[load] documents', de); setError({ retry: true, text: "Couldn't load this load's documents." }); }
    else setDocs(d || []);
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && u) setTimeout(() => fetchAll(), 0);
      if (event === 'SIGNED_OUT') { setLoad(null); setDocs([]); }
    });
    return () => sub.subscription.unsubscribe();
  }, [id]);

  async function changeStatus(status) {
    const prev = load.status;
    setLoad({ ...load, status });
    list?.patchLoad(id, { status });
    setSaving(true);
    try {
      const { error } = await supabase.from('loads').update({ status }).eq('id', id);
      if (error) { setLoad((l) => ({ ...l, status: prev })); list?.patchLoad(id, { status: prev }); console.error('[load] status', error); setError({ retry: false, text: "Couldn't update the status. Please try again." }); }
    } finally {
      setSaving(false);
    }
  }

  async function view(doc) {
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(doc.file_path, 300);
    if (error) { console.error('[load] open file', error); return setError({ retry: false, text: "Couldn't open the file. Please try again." }); }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  const hasStatus = load && Object.prototype.hasOwnProperty.call(load, 'status');

  return (
    <main style={s.main}>
      <p style={{ margin: '0 0 0.25rem' }}>
        <Link href="/loads" style={{ ...s.link, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Loads</Link>
      </p>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <Link href="/login" style={s.link}>sign in</Link> to view this load.</p>
        : (
          <>
            {error && (error.retry ? <LoadError message={error.text} onRetry={fetchAll} /> : <p style={s.error}>{error.text}</p>)}
            {!load ? (!error && <Loading label="Loading load…" />) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                  <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0' }}>{load.broker_load_number ? `Load #${load.broker_load_number}` : 'Load'}</h1>
                  {hasStatus && <StatusBadge status={load.status} />}
                </div>

                <div style={s.card}>
                  <dl style={s.dl}>
                    {[
                      ['Broker', load.broker_name || '—'],
                      ['Rate', fmtMoney(load.rate)],
                      ['Rate/mile', load.rate_per_mile != null ? fmtMoney(load.rate_per_mile) : null],
                      ['Miles', load.total_miles != null ? fmtNumber(load.total_miles) : null],
                      ['Commodity', load.commodity],
                      ['Weight', load.weight != null ? fmtNumber(load.weight, ' lb') : null],
                      ['Equipment', load.equipment_type],
                      ['Instructions', load.special_instructions],
                      ['Notes', load.notes],
                      ['Created', new Date(load.created_at).toLocaleString()],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt style={s.muted}>{k}</dt>
                        <dd style={{ margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-line', fontWeight: k === 'Rate' ? 600 : 400 }}>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {hasStatus && (
                    <label style={{ display: 'block', marginTop: '0.75rem' }}>
                      <span style={s.muted}>Status </span>
                      <select value={load.status || ''} disabled={saving} onChange={(e) => changeStatus(e.target.value)}
                        style={{ fontSize: '1rem', padding: '0.4rem', borderRadius: 8, border: '1px solid #d1d5db' }}>
                        {!STATUSES.includes(load.status) && <option value={load.status || ''}>{load.status || '—'}</option>}
                        {STATUSES.map((st) => <option key={st} value={st}>{st.replaceAll('_', ' ')}</option>)}
                      </select>
                    </label>
                  )}
                </div>

                <div style={s.card}>
                  <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Stops</h2>
                  {load.stops.length === 0 ? <p style={s.muted}>No stops.</p> : load.stops.map((st, i) => (
                    <div key={st.id} style={{ ...s.row, alignItems: 'flex-start', borderBottom: i === load.stops.length - 1 ? 'none' : s.row.borderBottom }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{st.sequence ?? i + 1}. {st.stop_type || 'stop'}</div>
                        {st.company_name && <div>{st.company_name}</div>}
                        {fullAddress(st) && <div style={s.muted}>{fullAddress(st)}</div>}
                        {(st.contact_name || st.contact_phone) && (
                          <div style={s.muted}>
                            {st.contact_name}{st.contact_name && st.contact_phone ? ' · ' : ''}
                            {st.contact_phone && <a href={`tel:${st.contact_phone}`} style={s.link}>{st.contact_phone}</a>}
                          </div>
                        )}
                        {st.notes && <div style={{ ...s.muted, whiteSpace: 'pre-line' }}>{st.notes}</div>}
                      </div>
                      <div style={{ ...s.muted, textAlign: 'right', maxWidth: '45%' }}>
                        {fmtApptWindow(st.appointment_start, st.appointment_end, st.timezone)}
                      </div>
                    </div>
                  ))}
                </div>

                <LoadMileage load={load} userId={user.id} onLoadChange={(patch) => setLoad((l) => ({ ...l, ...patch }))} />
                <LoadExpenses loadId={id} rate={load.rate} />
                <div style={s.card}>
                  <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Documents</h2>
                  {docs.length === 0 ? <p style={s.muted}>No linked documents.</p> : docs.map((d) => (
                    <div key={d.id} style={s.row}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename}</div>
                        <div style={s.muted}>{(d.doc_type || '').replaceAll('_', ' ')} · {new Date(d.created_at).toLocaleDateString()}</div>
                      </div>
                      <button onClick={() => view(d)} style={s.btn}>View</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
    </main>
  );
}
