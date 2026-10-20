'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { uploadScan } from '../../lib/scanUpload';
import { mergeFetchedLoad, settleStatus } from '../../lib/loadStatus';
import Link from 'next/link';
import SignInLink from '../../components/SignInLink';
import { useParams, useRouter } from 'next/navigation';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import LoadMileage from '../../components/LoadMileage';
import LoadRouteCard from '../../components/LoadRouteCard';
import { stopAddressText } from '../../lib/loadRoute';
import { onLoadChanged } from '../../lib/loadSync';
import LoadScaleTickets from '../../components/LoadScaleTickets';
import LoadExpenses from '../../components/LoadExpenses';
import LoadDriverSettings from '../../components/LoadDriverSettings';
import { Loading, LoadError } from '../../components/DataState';
import { useLoads } from '../LoadsData';
import ConfirmButton from '../../components/ui/ConfirmButton';
import { deleteLoad, loadDeletePrompt } from '../../lib/loadDelete';
import { docTypeLabel, LOAD_SCAN_TYPE_IDS } from '../../lib/docTypes';
import { fetchLoadDocs } from '../../lib/loadDocsClient';
import LoadDocThumb from '../../components/LoadDocThumb';
import { parseWeightLb } from '../../lib/loadWeight';
import { isLoadId } from '../../lib/loadNew';
import { takeSeededLoad } from '../../lib/loadSeed';
import { STATUSES, StatusBadge, fmtMoney, fmtNumber, fmtApptWindow, fullAddress } from '../../lib/loads';

// Loaded only when "Scan BOL/POD" is tapped.
const Scanner = dynamic(() => import('../../components/scanner/Scanner'), { ssr: false, loading: () => null });

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid var(--divider)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  error: { color: 'var(--danger)' },
  link: { color: 'var(--primary)' },
  btn: { minHeight: 44, minWidth: 64, padding: '0.5rem 0.9rem', fontSize: '0.9rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)' },
  dl: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 0.75rem', margin: 0, fontSize: '0.9rem' },
};

export default function LoadDetailPage() {
  const { id } = useParams();
  const supabase = getSupabase();
  const list = useLoads(); // shared list (desktop left pane); kept in sync on status change
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  // Just created on /loads/new? Show it at once; fetchAll() still refreshes it (#86 QA).
  const [load, setLoad] = useState(() => (isLoadId(id) ? takeSeededLoad(id) : null));
  const [docs, setDocs] = useState([]);
  const [weightEdit, setWeightEdit] = useState(null); // text while editing loads.weight, else null
  const [weightErr, setWeightErr] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const statusVer = useRef(0); // bumped on every status change; older fetches keep the newer status
  const router = useRouter();
  const [alsoDocs, setAlsoDocs] = useState(false);
  const [delError, setDelError] = useState(null);
  const [linked, setLinked] = useState({ expenses: 0, mileage: 0 });
  const [routeCheck, setRouteCheck] = useState(0); // bumped when Planned is cleared: the map card re-checks
  const [dataVer, setDataVer] = useState(0); // bumped on every re-fetch so child cards (Miles) re-read too

  async function fetchAll() {
    setError(null);
    const ver = statusVer.current;
    // Not a load id (e.g. an old link or a typo): say so instead of querying loads.id = '<text>' and waiting forever.
    if (!isLoadId(id)) return setError({ retry: false, text: 'Load not found.' });
    if (!(await hasSession(supabase))) return setError({ retry: true, text: "Your session has expired or is still loading. Tap Retry, or sign in again." });
    const [{ data: l, error: le }, { data: d, error: de }] = await Promise.all([
      supabase.from('loads').select('*, stops(*)').eq('id', id).maybeSingle(),
      fetchLoadDocs(supabase, id),
    ]);
    if (le) { console.error('[load] fetch', le); return setError({ retry: true, text: "Couldn't load this load." }); }
    if (!l) return setError({ retry: false, text: 'Load not found.' });
    l.stops = [...(l.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    setLoad((cur) => mergeFetchedLoad(cur, l, ver !== statusVer.current));
    const [{ count: ec }, { count: mc }] = await Promise.all([
      supabase.from('expenses').select('id', { count: 'exact', head: true }).eq('load_id', id),
      supabase.from('mileage_entries').select('id', { count: 'exact', head: true }).eq('load_id', id),
    ]);
    setLinked({ expenses: ec || 0, mileage: mc || 0 });
    list?.patchLoad(id, { total_miles: l.total_miles, rate_per_mile: l.rate_per_mile, weight: l.weight });
    setDataVer((v) => v + 1);
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

  // Re-fetch when this load changed elsewhere (extraction / re-run on Documents, another tab), on a back/forward
  // cache restore, or when the tab is shown again. QA #82 (RC-03): Planned showed "—" until a browser reload.
  const fetchRef = useRef(fetchAll); fetchRef.current = fetchAll;
  const refreshAll = () => { router.refresh(); return fetchRef.current(); };
  useEffect(() => onLoadChanged(id, () => { if (user) refreshAll(); }), [id, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load weight (lb): copied from the rate con on create; editable here. The Truck tab compares scale tickets with it.
  async function saveWeight(e) {
    e.preventDefault();
    const txt = String(weightEdit || '').trim();
    const weight = txt ? parseWeightLb(txt) : null;
    if (txt && !weight) return setWeightErr('Enter a weight in pounds, like 38,500.');
    setWeightErr(null); setSaving(true);
    try {
      const { data: saved, error } = await supabase.from('loads').update({ weight }).eq('id', id).select('weight').maybeSingle();
      if (error || !saved) { console.error('[load] weight', error); return setWeightErr("Couldn't save the weight. Please try again."); }
      setLoad((l) => ({ ...l, weight: saved.weight }));
      list?.patchLoad(id, { weight: saved.weight });
      setWeightEdit(null);
    } finally { setSaving(false); }
  }

  async function changeStatus(status) {
    const prev = load.status;
    statusVer.current += 1;
    setLoad((l) => ({ ...l, status }));
    list?.patchLoad(id, { status });
    setSaving(true);
    try {
      const { data: saved, error } = await supabase.from('loads').update({ status }).eq('id', id).select('status').maybeSingle();
      statusVer.current += 1;
      const settled = settleStatus({ status }, { error, saved, prev }).status;
      setLoad((l) => settleStatus(l, { error, saved, prev }));
      list?.patchLoad(id, { status: settled });
      if (error) { console.error('[load] status', error); setError({ retry: false, text: "Couldn't update the status. Please try again." }); }
    } finally {
      setSaving(false);
    }
  }

  async function view(doc) {
    if (doc.url) return window.open(doc.url, '_blank', 'noopener'); // signed by /api/loads/:id/documents (10 min)
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(doc.file_path, 300);
    if (error) { console.error('[load] open file', error); return setError({ retry: false, text: "Couldn't open the file. Please try again." }); }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  // Only the owner deletes loads, and only his own uploads can be deleted with it; team members' uploads are unlinked.
  const ownDocs = docs.filter((d) => d.own !== false);
  async function removeLoad() {
    setDelError(null);
    const r = await deleteLoad(supabase, id, { docs: ownDocs, deleteDocs: alsoDocs });
    if (!r.ok) { console.error('[load] delete', r.error); setDelError(r.error); fetchAll(); return false; }
    list?.reload(); // the shared list (layout) outlives this page; drop the deleted load
    if (r.warnings?.length) { console.warn('[load] delete', r.warnings); return router.replace(`/loads?notice=${encodeURIComponent(r.warnings.join(' '))}`); }
    router.replace('/loads');
  }

  const hasStatus = load && Object.prototype.hasOwnProperty.call(load, 'status');

  return (
    <main style={s.main}>
      <p style={{ margin: '0 0 0.25rem' }}>
        <Link href="/loads" style={{ ...s.link, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>← Loads</Link>
      </p>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to view this load.</p>
        : (
          <>
            {error && (error.retry ? <LoadError message={error.text} onRetry={fetchAll} /> : <p style={s.error}>{error.text}</p>)}
            {!load ? (!error && <Loading label="Loading load…" />) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                  <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0' }}>{load.broker_load_number ? `Load #${load.broker_load_number}` : 'Load'}</h1>
                  {hasStatus && <StatusBadge status={load.status} />}
                </div>

                {/* PR B: map + truck route miles; recomputed only when the stop addresses change. */}
                <LoadRouteCard supabase={supabase} loadId={load.id} stopsKey={load.stops.map(stopAddressText).join('|')} recheck={routeCheck}
                  onLoadChange={(patch) => setLoad((l) => ({ ...l, ...patch }))} onRouteFilled={refreshAll} />

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
                  {weightEdit === null ? (
                    <button type="button" data-testid="edit-weight" onClick={() => { setWeightErr(null); setWeightEdit(load.weight != null ? String(load.weight) : ''); }}
                      style={{ marginTop: '0.5rem', minHeight: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 14 }}>
                      {load.weight != null ? 'Edit weight' : 'Add weight'}
                    </button>
                  ) : (
                    <form onSubmit={saveWeight} data-testid="weight-form" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                      <label style={{ flex: '1 1 160px' }}><span style={s.muted}>Weight (lb)</span>
                        <input id="load-weight" inputMode="numeric" value={weightEdit} onChange={(e) => setWeightEdit(e.target.value)} placeholder="38,500"
                          style={{ display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
                      </label>
                      <button type="button" onClick={() => setWeightEdit(null)} style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>Cancel</button>
                      <button type="submit" disabled={saving} style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600 }}>Save</button>
                      {weightErr && <p role="alert" style={{ color: 'var(--danger)', fontSize: 14, margin: 0, flexBasis: '100%' }}>{weightErr}</p>}
                    </form>
                  )}
                  {hasStatus && (
                    <label style={{ display: 'block', marginTop: '0.75rem' }}>
                      <span style={s.muted}>Status </span>
                      <select value={load.status || ''} disabled={saving} onChange={(e) => changeStatus(e.target.value)}
                        style={{ fontSize: '1rem', padding: '0.4rem', borderRadius: 8, border: '1px solid var(--text-muted)', background: 'var(--surface)', color: 'var(--text)', colorScheme: 'inherit' }}>
                        {!STATUSES.includes(load.status) && <option value={load.status || ''}>{load.status || '—'}</option>}
                        {STATUSES.map((st) => <option key={st} value={st}>{st.replaceAll('_', ' ')}</option>)}
                      </select>
                    </label>
                  )}
                </div>

                {/* Assigned driver + "Show rate to driver": only once migration 20261018000600 added the columns. */}
                {Object.prototype.hasOwnProperty.call(load, 'show_rate_to_driver') && (
                  <LoadDriverSettings supabase={supabase} load={load} cardStyle={s.card}
                    onSaved={(patch) => { setLoad((l) => ({ ...l, ...patch })); list?.patchLoad(id, patch); }} />
                )}

                <div style={s.card}>
                  <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Stops</h2>
                  {load.stops.length === 0 ? <p style={s.muted}>No stops.</p> : load.stops.map((st, i) => (
                    <div key={st.id} style={{ ...s.row, alignItems: 'flex-start', borderBottom: i === load.stops.length - 1 ? 'none' : s.row.borderBottom }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{st.sequence ?? i + 1}. {st.stop_type || 'stop'}</div>
                        {st.company_name && <div>{st.company_name}</div>}
                        {fullAddress(st) && <div style={s.muted}>{fullAddress(st)}</div>}
                        {st.pickup_number && <div style={s.muted}>Pickup # {st.pickup_number}</div>}
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

                <LoadScaleTickets supabase={supabase} loadId={load.id} loadWeight={load.weight} cardStyle={s.card} />
                <LoadMileage load={load} userId={user.id} refreshKey={dataVer} onPlannedCleared={() => setRouteCheck((n) => n + 1)} onLoadChange={(patch) => setLoad((l) => ({ ...l, ...patch }))} />
                <LoadExpenses loadId={id} rate={load.rate} />
                <div style={s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Documents</h2>
                    <button type="button" onClick={() => { setScanMsg(null); setScanning(true); }} style={{ ...s.btn, background: 'var(--surface)', color: 'var(--primary)', border: '1px solid var(--primary)' }}>🧾 Scan document</button>
                  </div>
                  {scanMsg && <p role="status" style={{ color: 'var(--success)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>{scanMsg}</p>}
                  {docs.length === 0 ? <p style={s.muted}>No linked documents. Scanned BOLs, PODs and scale tickets show here once linked to this load.</p> : docs.map((d) => (
                    <div key={d.id} data-testid="load-doc-row" data-doc-type={d.doc_type} style={s.row}>
                      <LoadDocThumb doc={d} onOpen={() => view(d)} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename}</div>
                        <div style={s.muted}><strong data-testid="load-doc-type" style={{ color: 'var(--text)' }}>{d.label || docTypeLabel(d.doc_type)}</strong> · {new Date(d.created_at).toLocaleDateString()}</div>
                      </div>
                      <button onClick={() => view(d)} style={s.btn}>View</button>
                    </div>
                  ))}
                </div>
                <div style={{ ...s.card, borderColor: 'var(--danger-border)' }}>
                  <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Delete load</h2>
                  <p style={{ ...s.muted, marginTop: 0 }}>Stops are deleted. Expenses and mileage are kept and unlinked.</p>
                  {ownDocs.length > 0 && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, cursor: 'pointer' }}>
                      <input type="checkbox" checked={alsoDocs} onChange={(e) => setAlsoDocs(e.target.checked)} style={{ width: 22, height: 22 }} />
                      <span>Also delete {ownDocs.length} linked document{ownDocs.length === 1 ? '' : 's'}</span>
                    </label>
                  )}
                  {alsoDocs && <p style={{ ...s.error, fontSize: '0.85rem', margin: '0 0 0.5rem' }}>Warning: the document files are permanently deleted and can't be recovered.</p>}
                  <ConfirmButton label="Delete load" prompt={loadDeletePrompt(ownDocs.length, alsoDocs, linked)} onConfirm={removeLoad} />
                  {delError && <p role="alert" style={{ ...s.error, margin: '0.5rem 0 0' }}>{delError}</p>}
                </div>
              </>
            )}
          </>
        )}
      {scanning && load && (
        <Scanner
          loads={[{ id: load.id, label: [load.broker_load_number ? `#${load.broker_load_number}` : 'This load', load.broker_name].filter(Boolean).join(' · ') }]}
          initialLoadId={load.id}
          typeIds={LOAD_SCAN_TYPE_IDS}
          onClose={() => setScanning(false)}
          onSave={async (scan) => {
            const err = await uploadScan(supabase, user?.id, scan);
            if (err && !err.saved) return err;
            setScanning(false);
            setScanMsg(err?.warning || `Saved ${scan.file.name}.`);
            await fetchAll();
            return null;
          }} />
      )}
    </main>
  );
}
