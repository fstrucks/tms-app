'use client';
// Maintenance vault (PR 3): every shop invoice / work order, filed per truck and searchable.
// /maintenance/vault lists all trucks; ?truck=<id> filters to one (Casey's Docs-tab tile links here).
// Scanning reads a document and pre-fills the Log service form; nothing is saved until the user presses Save.
// A document can also be stored with no scan. Data: /api/maintenance/vault (access decided in SQL).
import { Suspense, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import { receiptType, receiptPath, RECEIPT_TYPES, fmtMiles, fmtMoney } from '../../lib/maintenance';
import { laToday } from '../../lib/sendCap';
import { maintenanceVaultHref } from '../../lib/maintenanceVault';
import MaintenanceSection from '../../truck/MaintenanceSection';

const Scanner = dynamic(() => import('../../components/scanner/Scanner'), { ssr: false, loading: () => null });

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 680, margin: '0 auto', boxSizing: 'border-box' },
  card: { background: 'var(--surface)', border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  h2: { fontSize: 18, margin: '0 0 0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid var(--divider)', fontSize: 15 },
  k: { color: 'var(--text-muted)' },
  muted: { color: 'var(--text-muted)', fontSize: 14 },
  err: { color: 'var(--danger)', fontSize: 14 },
  btn: { display: 'block', width: '100%', minHeight: 48, borderRadius: 10, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontSize: 16, fontWeight: 600, marginTop: 12 },
  btn2: { display: 'block', width: '100%', minHeight: 48, borderRadius: 10, border: '1px solid var(--primary)', background: 'var(--surface)', color: 'var(--primary)', fontSize: 16, fontWeight: 600, marginTop: 12 },
  small: { minHeight: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 14 },
  label: { display: 'block', fontSize: 14, fontWeight: 600, margin: '10px 0 4px' },
  input: { width: '100%', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', boxSizing: 'border-box' },
};
const mdy = (d) => (d ? `${String(d).slice(5, 7)}/${String(d).slice(8, 10)}/${String(d).slice(0, 4)}` : '');
const unit = (t) => t?.unit_number || 'Truck';

export default function VaultPage() {
  return <Suspense fallback={<main style={s.main}><p style={s.muted}>Loading…</p></main>}><Vault /></Suspense>;
}

function Vault() {
  const supabase = getSupabase();
  const router = useRouter();
  const params = useSearchParams();
  const truckParam = params.get('truck') || '';
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null); // { file, truckId, notes } picked, not uploaded yet
  const [scanFiles, setScanFiles] = useState(null);
  const [review, setReview] = useState(null); // { key, doc: { id, truck_id }, inv } -> pre-filled Log service form
  const [edit, setEdit] = useState(null); // { id, values }
  const fileRef = useRef(null);
  const seq = useRef(0);

  async function api(path, opts = {}) {
    const t = (await supabase.auth.getSession())?.data?.session?.access_token;
    let res;
    try { res = await fetch(path, { ...opts, cache: 'no-store', headers: { Authorization: `Bearer ${t || ''}`, 'Content-Type': 'application/json' } }); }
    catch { return { error: 'Couldn’t reach the server. Try again.' }; }
    const j = await res.json().catch(() => ({}));
    return res.ok ? j : { ...j, error: j.error || `Something went wrong (${res.status}).` };
  }
  async function load() {
    const n = ++seq.current;
    const j = await api(`/api/maintenance/vault?${truckParam ? `truck=${encodeURIComponent(truckParam)}&` : ''}q=${encodeURIComponent(q.trim())}&_=${Date.now()}`);
    if (n === seq.current) setD(j);
  }

  useEffect(() => {
    if (!supabase) { setChecking(false); return; }
    supabase.auth.getSession().then(({ data }) => { setUser(data?.session?.user || null); setChecking(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!user) return; const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [user, truckParam, q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!supabase) return <main style={s.main}><p style={s.err}>{supabaseConfigError || 'App is not configured.'}</p></main>;
  if (checking) return <main style={s.main}><p style={s.muted}>Loading…</p></main>;
  if (!user) return <main style={s.main}><p>Sign in to see maintenance documents.</p><a href="/" style={s.btn2}>Sign in</a></main>;

  const trucks = d?.trucks || [];
  const docs = d?.docs || [];
  const manageable = trucks.filter((t) => t.can_manage);
  const truckById = Object.fromEntries(trucks.map((t) => [t.id, t]));
  const setTruck = (id) => router.replace(maintenanceVaultHref(id || undefined));

  function pick(file) {
    if (!file) return;
    if (!receiptType(file)) return setMsg({ type: 'error', text: 'Use a PDF or a photo (JPEG, PNG, WebP or HEIC).' });
    if (file.size > 10 * 1024 * 1024) return setMsg({ type: 'error', text: 'Files can be up to 10 MB.' });
    setMsg(null);
    setPending({ file, truckId: manageable.some((t) => t.id === truckParam) ? truckParam : (manageable.length === 1 ? manageable[0].id : ''), notes: '' });
  }

  // Uploads to the user's own folder, then files it under the truck. -> doc id or null
  async function upload() {
    const { file, truckId, notes } = pending;
    const type = receiptType(file);
    const path = receiptPath(user.id, file.name || 'document');
    const up = await supabase.storage.from('documents').upload(path, file, { contentType: type, upsert: false });
    if (up.error) { setMsg({ type: 'error', text: 'Upload failed. Check your connection and try again.' }); return null; }
    const j = await api('/api/maintenance/vault', { method: 'POST', body: JSON.stringify({ action: 'add', truckId, filePath: path, filename: file.name || 'document', notes }) });
    if (j.error) { await supabase.storage.from('documents').remove([path]); setMsg({ type: 'error', text: j.error }); return null; }
    return j.id;
  }
  async function scanDoc(doc) {
    setBusy(`scan-${doc.id}`); setMsg(null);
    const j = await api('/api/maintenance/vault', { method: 'POST', body: JSON.stringify({ action: 'scan', id: doc.id, today: laToday() }) });
    setBusy(null);
    if (j.error) { setMsg({ type: 'error', text: j.error }); return; }
    const inv = j.suggestion;
    if (!inv.isInvoice) setMsg({ type: 'error', text: 'This doesn’t look like a shop invoice or work order. Check the details carefully.' });
    if (truckParam !== doc.truck_id) setTruck(doc.truck_id);
    setReview({ key: `${doc.id}-${Date.now()}`, doc, inv });
  }
  async function submitPending(withScan) {
    if (!pending.truckId) return setMsg({ type: 'error', text: 'Pick the truck this document is for.' });
    setBusy('upload');
    const id = await upload();
    setBusy(null);
    if (!id) return;
    const { truckId, notes } = pending;
    setPending(null);
    await load();
    if (withScan) await scanDoc({ id, truck_id: truckId, notes: notes.trim() || null });
    else setMsg({ type: 'ok', text: 'Document saved to the vault.' });
  }
  // Called by MaintenanceSection after the user pressed Save on the pre-filled visit. -> error text or null
  async function linkReviewed(recordId, f) {
    const { doc, inv } = review;
    const j = await api('/api/maintenance/vault', { method: 'POST', body: JSON.stringify({ action: 'link', id: doc.id, recordId,
      values: { vendor: f.vendor, date: f.serviceDate, total: f.totalCost, odometer: f.odometer, notes: doc.notes ?? null, text: inv.text, scanned: true } }) });
    setReview(null); await load();
    if (j.error) return `the document wasn’t attached to it (${j.error}).`;
    setMsg({ type: 'ok', text: 'Service saved and the document is attached to it.' });
    return null;
  }
  async function open(doc) {
    const w = window.open('', '_blank');
    const j = await api('/api/maintenance/vault', { method: 'POST', body: JSON.stringify({ action: 'open', id: doc.id }) });
    if (j.error || !j.url) { w?.close(); return setMsg({ type: 'error', text: j.error || 'Could not open the document.' }); }
    if (w) w.location.href = j.url; else window.location.href = j.url;
  }
  async function saveEdit(e) {
    e.preventDefault();
    setBusy('edit');
    const j = await api('/api/maintenance/vault', { method: 'POST', body: JSON.stringify({ action: 'save', id: edit.id, values: edit.values }) });
    setBusy(null);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    setEdit(null); setMsg({ type: 'ok', text: 'Details saved.' }); await load();
  }
  async function remove(doc) {
    if (!window.confirm(doc.service_record_id ? 'Delete this document? The service visit stays in the log.' : 'Delete this document?')) return;
    setBusy(`del-${doc.id}`);
    const j = await api('/api/maintenance/vault', { method: 'POST', body: JSON.stringify({ action: 'delete', id: doc.id }) });
    setBusy(null);
    setMsg(j.error ? { type: 'error', text: j.error } : { type: 'ok', text: 'Document deleted.' });
    await load();
  }
  const ev = (k) => (e) => setEdit((o) => ({ ...o, values: { ...o.values, [k]: e.target.value } }));

  const reviewTruck = review && (truckById[review.doc.truck_id] ? { id: review.doc.truck_id, unit_number: truckById[review.doc.truck_id].unit_number } : { id: review.doc.truck_id });
  return (
    <main style={s.main} data-testid="maintenance-vault">
      <p style={{ margin: '0 0 8px' }}><a href="/truck" style={{ color: 'var(--primary)' }}>← Truck</a></p>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Maintenance documents</h1>
      <p style={{ ...s.muted, margin: '0 0 12px' }}>Shop invoices and work orders, filed by truck.</p>

      {d?.setupNeeded && <p style={s.err}>{d.error}</p>}
      {d?.error && !d.setupNeeded && <p style={s.err}>{d.error}</p>}
      {msg && <p role="status" data-testid="vault-msg" style={msg.type === 'error' ? s.err : { ...s.muted, color: 'var(--success)' }}>{msg.text}</p>}

      {d?.available && (<>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 12 }}>
          <label style={{ ...s.label, margin: 0 }} htmlFor="vault-truck">Truck</label>
          <select id="vault-truck" data-testid="vault-truck" style={s.input} value={truckParam} onChange={(e) => { setReview(null); setTruck(e.target.value); }}>
            <option value="">All trucks</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{unit(t)} ({t.doc_count})</option>)}
          </select>
          <label style={{ ...s.label, margin: 0 }} htmlFor="vault-q">Search</label>
          <input id="vault-q" data-testid="vault-search" type="search" style={s.input} placeholder="Shop, date, notes or anything on the document" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
        </div>

        {manageable.length > 0 && !review && (
          <section style={s.card} aria-label="Add a document">
            <h2 style={s.h2}>Add a document</h2>
            {!pending ? (<>
              <input ref={fileRef} type="file" accept={`${RECEIPT_TYPES.join(',')},.heic,.heif`} style={{ display: 'none' }} data-testid="vault-file"
                onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
              <button type="button" data-testid="vault-camera" style={s.btn} onClick={() => setScanFiles([])}>📷 Scan with camera</button>
              <button type="button" data-testid="vault-choose" style={s.btn2} onClick={() => fileRef.current?.click()}>Choose a PDF or photo</button>
            </>) : (
              <div data-testid="vault-pending">
                <p style={{ margin: '0 0 4px', overflowWrap: 'anywhere' }}><strong>{pending.file.name}</strong></p>
                <label style={s.label} htmlFor="vault-pending-truck">Truck</label>
                <select id="vault-pending-truck" data-testid="vault-pending-truck" style={s.input} value={pending.truckId} onChange={(e) => setPending((p) => ({ ...p, truckId: e.target.value }))}>
                  <option value="">Pick a truck</option>
                  {manageable.map((t) => <option key={t.id} value={t.id}>{unit(t)}</option>)}
                </select>
                <label style={s.label} htmlFor="vault-pending-notes">Notes (optional)</label>
                <input id="vault-pending-notes" style={s.input} value={pending.notes} maxLength={1000} onChange={(e) => setPending((p) => ({ ...p, notes: e.target.value }))} />
                <button type="button" data-testid="vault-scan" style={s.btn} disabled={!!busy} onClick={() => submitPending(true)}>{busy ? 'Working…' : 'Save and scan'}</button>
                <button type="button" data-testid="vault-store-only" style={s.btn2} disabled={!!busy} onClick={() => submitPending(false)}>Store only</button>
                <button type="button" style={{ ...s.small, marginTop: 12 }} disabled={!!busy} onClick={() => setPending(null)}>Cancel</button>
                <p style={{ ...s.muted, fontSize: 12, margin: '8px 0 0' }}>Scanning reads the date, miles, shop, total and services and fills in a service visit for you to check. Nothing is logged until you press Save.</p>
              </div>
            )}
          </section>
        )}

        {review && reviewTruck && (
          <div data-testid="vault-review">
            <MaintenanceSection truck={reviewTruck} api={api} supabase={supabase} user={user} s={s}
              prefill={{ key: review.key, inv: review.inv }} onPrefillSaved={linkReviewed}
              onPrefillCancel={() => { setReview(null); setMsg({ type: 'ok', text: 'Nothing was logged. The document is still in the vault.' }); }} />
          </div>
        )}

        <section aria-label="Documents" data-testid="vault-list">
          {!docs.length && <p style={s.muted}>{q ? 'No documents match.' : 'No maintenance documents yet.'}</p>}
          {docs.map((doc) => (
            <article key={doc.id} style={s.card} data-testid="vault-doc">
              {edit?.id === doc.id ? (
                <form onSubmit={saveEdit}>
                  <label style={s.label} htmlFor="ve-vendor">Shop / vendor</label>
                  <input id="ve-vendor" style={s.input} value={edit.values.vendor} onChange={ev('vendor')} maxLength={120} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div><label style={s.label} htmlFor="ve-date">Date</label><input id="ve-date" type="date" style={s.input} value={edit.values.date} max={laToday()} onChange={ev('date')} /></div>
                    <div><label style={s.label} htmlFor="ve-miles">Miles</label><input id="ve-miles" inputMode="numeric" style={s.input} value={edit.values.odometer} onChange={ev('odometer')} /></div>
                  </div>
                  <label style={s.label} htmlFor="ve-total">Total</label>
                  <input id="ve-total" inputMode="decimal" style={s.input} value={edit.values.total} onChange={ev('total')} />
                  <label style={s.label} htmlFor="ve-notes">Notes</label>
                  <input id="ve-notes" style={s.input} value={edit.values.notes} onChange={ev('notes')} maxLength={1000} />
                  <button style={s.btn} disabled={!!busy}>Save</button>
                  <button type="button" style={s.btn2} onClick={() => setEdit(null)}>Cancel</button>
                </form>
              ) : (<>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{doc.vendor || doc.original_filename || 'Document'}</strong>
                  <span style={{ ...s.muted, whiteSpace: 'nowrap' }}>{mdy(doc.doc_date) || mdy(String(doc.created_at).slice(0, 10))}</span>
                </div>
                <div style={{ ...s.muted, display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 4 }}>
                  <span>{doc.unit_number || 'Truck'}</span>
                  {doc.total != null && <span>{fmtMoney(doc.total)}</span>}
                  {doc.odometer != null && <span>{fmtMiles(doc.odometer)}</span>}
                  {doc.service_record_id ? <span data-testid="vault-linked" style={{ color: 'var(--success)' }}>Logged{doc.service_date ? ` ${mdy(doc.service_date)}` : ''}</span> : <span>Not logged</span>}
                </div>
                {doc.notes && <p style={{ margin: '6px 0 0', fontSize: 14 }}>{doc.notes}</p>}
                {doc.vendor && doc.original_filename && <p style={{ ...s.muted, fontSize: 12, margin: '4px 0 0', overflowWrap: 'anywhere' }}>{doc.original_filename}</p>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  <button type="button" style={s.small} onClick={() => open(doc)}>Open</button>
                  {doc.can_manage && !doc.service_record_id && <button type="button" data-testid="vault-doc-scan" style={s.small} disabled={!!busy || !!review} onClick={() => scanDoc(doc)}>{busy === `scan-${doc.id}` ? 'Scanning…' : 'Scan and log'}</button>}
                  {doc.can_manage && <button type="button" style={s.small} onClick={() => setEdit({ id: doc.id, values: { vendor: doc.vendor || '', date: doc.doc_date ? String(doc.doc_date).slice(0, 10) : '', odometer: doc.odometer ?? '', total: doc.total ?? '', notes: doc.notes || '' } })}>Edit details</button>}
                  {doc.can_manage && <button type="button" style={{ ...s.small, color: 'var(--danger)' }} disabled={!!busy} onClick={() => remove(doc)}>Delete</button>}
                </div>
              </>)}
            </article>
          ))}
        </section>
      </>)}

      {scanFiles && <Scanner initialFiles={scanFiles} loads={[]} typeIds={['maintenance_doc']} onClose={() => setScanFiles(null)}
        onSave={async (sc) => { setScanFiles(null); pick(sc.file); return null; }} />}
    </main>
  );
}
