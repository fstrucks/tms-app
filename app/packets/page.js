'use client';

import { useEffect, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { uploadPacket, validatePacketFile } from '../lib/packetUpload';
import { VISUALLY_HIDDEN } from '../components/UploadMenu';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 560, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem 1rem', marginBottom: '0.75rem' },
  pick: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 8, border: '2px solid #2563eb', color: '#1d4ed8', background: '#eff6ff', fontWeight: 600, cursor: 'pointer', touchAction: 'manipulation' },
  muted: { color: '#6b7280', fontSize: 14, margin: '0.25rem 0 0' },
};
const FILE_ID = 'packet-upload-file';

export default function PacketsPage() {
  const [st, setSt] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function load() {
    const sb = getSupabase();
    if (!sb) return setSt({ error: supabaseConfigError });
    const { data } = await sb.auth.getSession();
    const user = data?.session?.user;
    if (!user) return setSt({ error: 'Sign in to see packets.', signedOut: true });
    const { data: prof } = await sb.from('company_profiles').select('owner_id').limit(1);
    const ownerId = prof?.[0]?.owner_id || user.id;
    const { data: rows, error } = await sb.from('packets').select('id,source,status,subject,original_filename,created_at').order('created_at', { ascending: false }).limit(50);
    if (error) return setSt({ error: 'Could not load packets.' });
    setSt({ user, ownerId, rows: rows || [] });
  }
  useEffect(() => { load(); }, []);

  async function onFile(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const v = validatePacketFile(f); if (v) return setMsg(v);
    setBusy(true); setMsg(null);
    let newId = null;
    const err = await uploadPacket(getSupabase(), { userId: st.user.id, ownerId: st.ownerId, file: f, onCreated: (id) => { newId = id; } });
    if (!err && newId) { // start field detection in the background; the packet page also retries it
      const { data } = await getSupabase().auth.getSession();
      fetch(`/api/packets/${newId}/process`, { method: 'POST', headers: { Authorization: `Bearer ${data?.session?.access_token}` } }).catch(() => {});
    }
    setBusy(false);
    if (err) setMsg(err); else { setMsg('Packet uploaded.'); load(); }
  }

  if (st.loading) return <main style={s.main}><p>Loading packets…</p></main>;
  if (st.error) return <main style={s.main}><h1>Carrier packets</h1><p role="alert" style={{ color: '#b91c1c' }}>{st.error}</p>{st.signedOut && <a href="/login?next=/packets">Sign in</a>}</main>;
  return (
    <main style={s.main}>
      <h1 style={{ marginBottom: '0.25rem' }}>Carrier packets</h1>
      <p style={s.muted}>Upload a broker packet PDF, or have brokers email it to packets@in.fstrucks.com once email-in is turned on.</p>
      <div style={{ margin: '1rem 0' }}>
        {/* iOS-safe: label htmlFor + visually hidden input; no hidden-by-display, no programmatic clicks. */}
        <input id={FILE_ID} type="file" accept="application/pdf,.pdf" onChange={onFile} style={VISUALLY_HIDDEN} tabIndex={-1} disabled={busy} />
        <label htmlFor={FILE_ID} role="button" style={{ ...s.pick, ...(busy ? { opacity: 0.5, pointerEvents: 'none' } : null) }}>{busy ? 'Uploading…' : '📄 Upload packet PDF'}</label>
        {msg && <p role="status" style={{ marginTop: '0.5rem' }}>{msg}</p>}
      </div>
      {st.rows.length === 0 ? <p style={s.muted}>No packets yet.</p> : st.rows.map((r) => (
        <a key={r.id} href={`/packets/${r.id}`} style={{ ...s.card, display: 'block', color: 'inherit', textDecoration: 'none' }}>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{r.subject || r.original_filename}</div>
          <p style={s.muted}>{r.source === 'email' ? 'Emailed' : 'Uploaded'} · {new Date(r.created_at).toLocaleString()} · {r.status === 'review' ? 'ready to fill out' : r.status}</p>
        </a>
      ))}
    </main>
  );
}
