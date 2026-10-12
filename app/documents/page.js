'use client';

import { useEffect, useRef, useState } from 'react';
import UploadMenu from '../components/UploadMenu';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabase, supabaseConfigError, hasSession } from '../lib/supabase';
import { fmtMoney } from '../lib/money';
import { Loading, LoadError } from '../components/DataState';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

// Browsers often report an empty (or generic) type for HEIC and some Android picks, so fall back to the extension.
function resolveType(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  // Never accept SVG (scriptable), whatever the extension or declared type says.
  if (ext === 'svg' || type.includes('svg')) return 'image/svg+xml';
  if (ALLOWED_TYPES.includes(type)) return type;
  // Declared type missing or not allowed (e.g. HEIC as octet-stream on Android): fall back to the extension.
  return EXT_TYPES[ext] || type;
}

const BUCKET = 'documents';

function isHeic(file, type) {
  return type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
}

// Convert HEIC/HEIF to JPEG in the browser. heic2any is loaded only when needed (client only).
async function convertHeicToJpeg(file) {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  const name = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
  input: { width: '100%', fontSize: '1rem' },
  pick: { minHeight: 48, padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8', touchAction: 'manipulation' },
  item: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 0', borderBottom: '1px solid #f1f5f9' },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  error: { color: '#b91c1c' },
  ok: { color: '#15803d' },
};

export default function DocumentsPage() {
  const supabase = getSupabase();
  const [signingOut, setSigningOut] = useState(false);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // remounts the hidden inputs to clear them

  // Both pickers feed the same state. Validate the real type/extension right away (the simple
  // accept list no longer filters, so unsupported files are caught here).
  function pickFile(f) {
    if (!f) return;
    const type = resolveType(f);
    if (!ALLOWED_TYPES.includes(type)) {
      setFile(null); setFileKey((k) => k + 1);
      return setStatus({ type: 'error', text: 'Unsupported file type. Use PDF, JPEG, PNG, WebP or HEIC/HEIF.' });
    }
    setStatus(null);
    setFile(f);
  }
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState(false);
  const router = useRouter();
  const [creating, setCreating] = useState({});

  const LOAD_ERRORS = {
    already_linked: 'This document is already linked to a load.',
    no_extracted_data: 'Run extraction first. This document has no extracted data.',
    document_not_found: 'Document not found.',
  };

  // Server-side, single transaction: creates load + stops and links the document.
  async function createLoad(doc) {
    if (doc.load_id || creating[doc.id]) return;
    setCreating((m) => ({ ...m, [doc.id]: true }));
    setStatus(null);
    try {
      const { data: loadId, error } = await supabase.rpc('create_load_from_document', {
        p_document: doc.id,
        // Extracted appointment times are local wall time; interpret them in this browser's timezone.
        p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
      });
      if (error) {
        const code = Object.keys(LOAD_ERRORS).find((k) => (error.message || '').includes(k));
        console.error('create_load_from_document', error);
        if (code === 'already_linked') loadDocs();
        throw new Error(LOAD_ERRORS[code] || 'Could not create the load, please try again.');
      }
      setDocs((list) => list.map((d) => (d.id === doc.id ? { ...d, load_id: loadId } : d)));
      router.push(`/loads/${loadId}`);
    } catch (err) {
      setStatus({ type: 'error', text: err.message });
    } finally {
      setCreating((m) => ({ ...m, [doc.id]: false }));
    }
  }

  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState([]);
  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const docsReqRef = useRef(0);
  const [refreshErr, setRefreshErr] = useState(null);
  const docsReadyRef = useRef(false);
  docsReadyRef.current = listState === 'ready';
  const [extracting, setExtracting] = useState({});
  const [extractErr, setExtractErr] = useState({});

  async function extract(id, force = false) {
    setExtracting((m) => ({ ...m, [id]: true }));
    setExtractErr((m) => ({ ...m, [id]: null }));
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token || ''}` },
        body: JSON.stringify({ documentId: id, force }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Extraction failed, please try again.');
      setDocs((list) => list.map((d) => (d.id === id ? { ...d, ai_extracted_data: body.data } : d)));
    } catch (err) {
      setExtractErr((m) => ({ ...m, [id]: err.message }));
    } finally {
      setExtracting((m) => ({ ...m, [id]: false }));
    }
  }


  async function loadDocs() {
    const req = ++docsReqRef.current;
    if (!docsReadyRef.current) setListState('loading');
    if (!(await hasSession(supabase))) { if (req === docsReqRef.current) { if (docsReadyRef.current) setRefreshErr("Your session has expired or is still loading. Tap Retry, or sign in again."); setListState((st) => (st === 'ready' ? 'ready' : 'error')); } return; }
    const { data, error } = await supabase
      .from('documents')
      .select('id, doc_type, file_path, original_filename, created_at, ai_extracted_data, load_id')
      .or('doc_type.is.null,doc_type.neq.receipt') // expense receipts live on /expenses
      .order('created_at', { ascending: false });
    if (req !== docsReqRef.current) return;
    if (error) {
      console.error('[documents] fetch', error);
      // Keep an already-shown list; otherwise show the error + Retry instead of an empty state.
      if (docsReadyRef.current) setRefreshErr("Couldn't refresh. Showing the last loaded documents.");
      return setListState((st) => (st === 'ready' ? 'ready' : 'error'));
    }
    setRefreshErr(null);
    setDocs(data || []);
    setListState('ready');
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    // INITIAL_SESSION fires once on subscribe, so no separate getSession() call is needed.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      // defer: avoid Supabase auth-lock deadlock. Fetch only with a session; re-fetch when it changes.
      if ((['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED'].includes(event) || (event === 'TOKEN_REFRESHED' && !docsReadyRef.current)) && u) setTimeout(() => loadDocs(), 0);
      if (event === 'SIGNED_OUT') { docsReqRef.current++; setDocs([]); setListState('loading'); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file || !user) return;
    let contentType = resolveType(file);
    if (!ALLOWED_TYPES.includes(contentType)) {
      return setStatus({ type: 'error', text: `Unsupported file type (${contentType || file.type || 'unknown'}). Use PDF, JPEG, PNG, WebP or HEIC/HEIF.` });
    }
    if (file.size > MAX_BYTES) {
      return setStatus({ type: 'error', text: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.` });
    }
    setStatus(null);
    let uploadFile = file;
    if (isHeic(file, contentType)) {
      setConverting(true);
      try {
        uploadFile = await convertHeicToJpeg(file);
        contentType = 'image/jpeg';
      } catch (err) {
        return setStatus({ type: 'error', text: 'Could not convert this iPhone photo (HEIC) to JPEG. Try exporting it as JPEG, or take a screenshot and upload that.' });
      } finally {
        setConverting(false);
      }
      if (uploadFile.size > MAX_BYTES) {
        return setStatus({ type: 'error', text: `Converted photo is too large (${(uploadFile.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.` });
      }
    }
    setUploading(true);
    const safeName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${user.id}/${Date.now()}-${safeName}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, uploadFile, { contentType });
    if (upErr) {
      setUploading(false);
      return setStatus({ type: 'error', text: 'Upload failed: ' + upErr.message });
    }
    const { data: inserted, error: dbErr } = await supabase.from('documents').insert({
      user_id: user.id,
      doc_type: 'rate_confirmation',
      file_path: path,
      original_filename: uploadFile.name, // converted HEIC is saved as .jpg
      load_id: null,
      truck_id: null,
    }).select('id').single();
    setUploading(false);
    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([path]);
      return setStatus({ type: 'error', text: 'Saving record failed: ' + dbErr.message });
    }
    setStatus({ type: 'ok', text: 'Uploaded ' + file.name });
    setFile(null); setFileKey((k) => k + 1);
    e.target.reset();
    await loadDocs();
    if (inserted?.id) extract(inserted.id);
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) setStatus({ type: 'error', text: 'Sign out failed: ' + error.message });
    } catch (err) {
      setStatus({ type: 'error', text: 'Sign out failed: ' + err.message });
    } finally {
      setSigningOut(false);
    }
  }

  async function view(doc) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
    if (error) return setStatus({ type: 'error', text: 'Could not open file: ' + error.message });
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.5rem' }}>Rate Confirmations</h1>

      {supabaseConfigError ? (
        <p style={s.error}>{supabaseConfigError}</p>
      ) : checking ? (
        <p style={s.muted}>Checking sign-in…</p>
      ) : !user ? (
        <div style={s.card}>
          <p style={s.error}>You need to be signed in to upload and view documents.</p>
          <Link href="/login" style={{ ...s.btn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>Sign in</Link>
        </div>
      ) : (
        <>
          <div style={{ ...s.item, borderBottom: 'none' }}>
            <span style={{ ...s.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>Signed in as {user.email}</span>
            <button onClick={handleSignOut} disabled={signingOut} style={{ ...s.btn, width: 'auto', marginTop: 0, padding: '0.5rem 0.9rem', background: '#6b7280', opacity: signingOut ? 0.6 : 1 }}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
          </div>
          <form onSubmit={handleUpload} style={s.card}>
            <fieldset style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }} disabled={uploading || converting}>
              <legend style={{ display: 'block', padding: 0, marginBottom: '0.5rem', fontWeight: 600 }}>Upload rate confirmation (PDF or image)</legend>
              <UploadMenu key={`menu-${fileKey}`} onFile={pickFile} disabled={uploading || converting} />
              <div aria-live="polite" aria-atomic="true">
                {file && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#111827' }}>
                      <span style={{ position: 'absolute', width: 1, height: 1, margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Selected file: </span>{file.name}
                    </span>
                    <button type="button" onClick={() => { setFile(null); setFileKey((k) => k + 1); }} aria-label="Remove selected file"
                      style={{ minWidth: 44, minHeight: 44, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff' }}>✕</button>
                  </div>
                )}
              </div>
            </fieldset>
            <div style={{ position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', zIndex: 10, background: '#fff', padding: '0.6rem 0 0.4rem', marginTop: '0.25rem' }}>
            <button type="submit" disabled={!file || uploading || converting} style={{ ...s.btn, marginTop: 0, opacity: !file || uploading || converting ? 0.6 : 1 }}>
              {converting ? 'Converting photo…' : uploading ? 'Uploading…' : 'Upload'}
            </button>
            </div>
          </form>

          {status && <p style={status.type === 'ok' ? s.ok : s.error}>{status.text}</p>}

          <div style={s.card}>
            <h2 style={{ fontSize: '1.1rem', marginTop: 0 }}>Uploaded documents</h2>
            {refreshErr && listState === 'ready' && <LoadError subtle message={refreshErr} onRetry={() => { setRefreshErr(null); loadDocs(); }} />}
            {listState === 'error' ? <LoadError message="Couldn't load your documents." onRetry={loadDocs} />
              : listState === 'loading' ? <Loading label="Loading documents…" />
              : docs.length === 0 ? <p style={s.muted}>No documents yet.</p> : docs.map((d) => (
              <div key={d.id} style={{ padding: '0.75rem 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ ...s.item, padding: 0, borderBottom: 'none' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename}</div>
                    <div style={s.muted}>{(d.doc_type || '').replaceAll('_', ' ')} · {new Date(d.created_at).toLocaleDateString()}</div>
                  </div>
                  <button onClick={() => view(d)} style={{ ...s.btn, width: 'auto', marginTop: 0, padding: '0.5rem 0.9rem' }}>View</button>
                </div>
                {extracting[d.id] ? (
                  <p style={s.muted}>Extracting…</p>
                ) : (
                  <>
                    {d.ai_extracted_data && <Summary x={d.ai_extracted_data} />}
                    {extractErr[d.id] && <p style={{ ...s.error, fontSize: '0.85rem' }}>{extractErr[d.id]}</p>}
                    <button onClick={() => (d.ai_extracted_data ? window.confirm('Re-run extraction? This overwrites the current data.') && extract(d.id, true) : extract(d.id))} style={{ background: 'none', border: 'none', color: '#2563eb', padding: '0.4rem 0', fontSize: '0.9rem' }}>
                      {d.ai_extracted_data ? 'Re-run extraction' : 'Run extraction'}
                    </button>
                    {d.load_id ? (
                      <Link href={`/loads/${d.load_id}`} style={{ ...s.btn, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box', background: '#059669', marginTop: '0.25rem' }}>View load</Link>
                    ) : d.ai_extracted_data ? (
                      <button onClick={() => createLoad(d)} disabled={!!creating[d.id]} style={{ ...s.btn, marginTop: '0.25rem', background: '#059669', opacity: creating[d.id] ? 0.6 : 1 }}>
                        {creating[d.id] ? 'Creating load…' : 'Create load'}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function fmtStop(st) {
  if (!st) return null;
  const when = [st.date, st.time].filter(Boolean).join(' ');
  return [when, st.address].filter(Boolean).join(' — ') || null;
}

function fmtParty(p) {
  if (!p) return null;
  return [p.name, p.address].filter(Boolean).join(', ') || null;
}

function Summary({ x }) {
  const rows = [
    ['Broker', x.broker_name],
    ['Load #', x.load_number],
    ['Refs', x.reference_numbers?.length ? x.reference_numbers.join(', ') : null],
    ['Rate', typeof x.rate === 'number' ? fmtMoney(x.rate) : null],
    ['Shipper', fmtParty(x.shipper)],
    ['Pickup', fmtStop(x.pickup)],
    ['Receiver', fmtParty(x.receiver)],
    ['Delivery', fmtStop(x.delivery)],
    ['Notes', x.notes],
  ].filter(([, v]) => v);
  if (!rows.length) return <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>No fields extracted.</p>;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', margin: '0.5rem 0 0', fontSize: '0.85rem', background: '#f8fafc', borderRadius: 8, padding: '0.6rem' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: '#6b7280' }}>{k}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-word' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
