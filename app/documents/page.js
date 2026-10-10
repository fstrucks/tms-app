'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

// Browsers often report an empty type for HEIC, so fall back to the extension.
function resolveType(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_TYPES[ext] || '';
}

const BUCKET = 'documents';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  btn: { width: '100%', padding: '0.85rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
  input: { width: '100%', fontSize: '1rem' },
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
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState([]);

  async function loadDocs() {
    const { data, error } = await supabase
      .from('documents')
      .select('id, doc_type, file_path, original_filename, created_at')
      .order('created_at', { ascending: false });
    if (error) return setStatus({ type: 'error', text: 'Could not load documents: ' + error.message });
    setDocs(data || []);
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    // INITIAL_SESSION fires once on subscribe, so no separate getSession() call is needed.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && u) setTimeout(() => loadDocs(), 0); // defer: avoid Supabase auth-lock deadlock
      if (event === 'SIGNED_OUT') setDocs([]);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file || !user) return;
    const contentType = resolveType(file);
    if (!ALLOWED_TYPES.includes(contentType)) {
      return setStatus({ type: 'error', text: `Unsupported file type (${contentType || file.type || 'unknown'}). Use PDF, JPEG, PNG, WebP or HEIC.` });
    }
    if (file.size > MAX_BYTES) {
      return setStatus({ type: 'error', text: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.` });
    }
    setUploading(true);
    setStatus(null);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${user.id}/${Date.now()}-${safeName}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType });
    if (upErr) {
      setUploading(false);
      return setStatus({ type: 'error', text: 'Upload failed: ' + upErr.message });
    }
    const { error: dbErr } = await supabase.from('documents').insert({
      user_id: user.id,
      doc_type: 'rate_confirmation',
      file_path: path,
      original_filename: file.name,
      load_id: null,
      truck_id: null,
      ai_extracted_data: null,
    });
    setUploading(false);
    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([path]);
      return setStatus({ type: 'error', text: 'Saving record failed: ' + dbErr.message });
    }
    setStatus({ type: 'ok', text: 'Uploaded ' + file.name });
    setFile(null);
    e.target.reset();
    loadDocs();
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
      <p><Link href="/" style={{ color: '#2563eb' }}>← Home</Link></p>
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
            <label htmlFor="file" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
              Upload rate confirmation (PDF or image)
            </label>
            <input id="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,.pdf,.jpg,.jpeg,.png,.webp,.heic" style={s.input}
              onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <button type="submit" disabled={!file || uploading} style={{ ...s.btn, opacity: !file || uploading ? 0.6 : 1 }}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </form>

          {status && <p style={status.type === 'ok' ? s.ok : s.error}>{status.text}</p>}

          <div style={s.card}>
            <h2 style={{ fontSize: '1.1rem', marginTop: 0 }}>Uploaded documents</h2>
            {docs.length === 0 ? <p style={s.muted}>No documents yet.</p> : docs.map((d) => (
              <div key={d.id} style={s.item}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.original_filename}</div>
                  <div style={s.muted}>{(d.doc_type || '').replaceAll('_', ' ')} · {new Date(d.created_at).toLocaleDateString()}</div>
                </div>
                <button onClick={() => view(d)} style={{ ...s.btn, width: 'auto', marginTop: 0, padding: '0.5rem 0.9rem' }}>View</button>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
