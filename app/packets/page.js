'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { uploadPacket, validatePacketFile } from '../lib/packetUpload';
import { makeApi } from '../lib/packetApi';
import { VISUALLY_HIDDEN } from '../components/UploadMenu';
import { isPendingStatus, PACKET_FILTERS, filterPackets, filterCounts, pollDelay, POLL_MAX_MS, statusChipStyle } from '../lib/packetStatus';
import { formatListTime } from '../lib/packetDate';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 560, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem 1rem', marginBottom: '0.75rem' },
  pick: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 8, border: '2px solid #2563eb', color: '#1d4ed8', background: '#eff6ff', fontWeight: 600, cursor: 'pointer', touchAction: 'manipulation' },
  muted: { color: '#6b7280', fontSize: 14, margin: '0.25rem 0 0' },
  chip: statusChipStyle,
  tab: (on) => ({ minHeight: 40, padding: '0 0.8rem', borderRadius: 999, border: `1px solid ${on ? '#2563eb' : '#d1d5db'}`, background: on ? '#2563eb' : '#fff', color: on ? '#fff' : '#111827', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', touchAction: 'manipulation' }),
  act: { minHeight: 40, padding: '0 0.8rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, touchAction: 'manipulation' },
  hint: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '0.4rem 0.6rem', fontSize: 14, margin: '0.5rem 0 0' },
};
const FILE_ID = 'packet-upload-file';
const packetApi = makeApi(() => getSupabase()?.auth);
const api = packetApi.call;
// Last list per signed-in user, shown instantly on the next visit while the fresh copy loads.
const cacheKey = (uid) => `packets-list-v1:${uid}`;
const readCache = (uid) => { try { return JSON.parse(sessionStorage.getItem(cacheKey(uid)) || 'null'); } catch { return null; } };
const writeCache = (uid, v) => { try { sessionStorage.setItem(cacheKey(uid), JSON.stringify(v)); } catch {} };

export default function PacketsPage() {
  const [st, setSt] = useState({ loading: true });
  const [filter, setFilter] = useState('all');
  const [archived, setArchived] = useState(null); // rows for the Archived filter, loaded when it's picked
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const user = useRef(null);
  const marked = useRef(false);
  const kicked = useRef(new Set()); // packets we've asked the server to start processing this visit

  const load = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return setSt({ error: supabaseConfigError });
    if (!user.current) {
      const { data } = await sb.auth.getSession(); // local; no network unless the token needs a refresh
      user.current = data?.session?.user || null;
      if (!user.current) return setSt({ error: 'Sign in to see packets.', signedOut: true });
      const c = readCache(user.current.id);
      if (c?.rows) setSt((p) => (p.rows ? p : { ...c, stale: true }));
    }
    const d = await api('/api/packets'); // one request: list + statuses + roles (see app/lib/packetList.js)
    if (d.signedOut) return setSt({ error: 'Sign in to see packets.', signedOut: true });
    if (d.error) return setSt((p) => (p.rows ? { ...p, stale: false, refreshError: d.error } : { error: 'Could not load packets.' }));
    const next = { rows: d.rows || [], ownerId: d.ownerId, archivedCount: d.archivedCount || 0, canManage: !!d.canManage };
    writeCache(user.current.id, next);
    setSt(next);
    if (!marked.current && typeof performance !== 'undefined') { marked.current = true; try { performance.mark('packets:list-ready'); } catch {} }
  }, []);
  const loadArchived = useCallback(async () => {
    const d = await api('/api/packets?view=archived');
    if (!d.error) { setArchived(d.rows || []); setSt((p) => (p.rows ? { ...p, archivedCount: (d.rows || []).length } : p)); }
    else setMsg(d.error);
  }, []);
  useEffect(() => { load().catch((e) => { console.error('[packets] load', e); setSt({ error: 'Could not load packets.' }); }); }, [load]);
  useEffect(() => { if (filter === 'archived') loadArchived(); }, [filter, loadArchived]);

  // Any packet still 'received' (upload kick lost, emailed while the webhook's job died, …): start it in the
  // background once per visit, so nothing sits at 'Waiting to start' until someone opens it (QA D).
  useEffect(() => {
    for (const r of st.rows || []) {
      if (r.status !== 'received' || kicked.current.has(r.id)) continue;
      kicked.current.add(r.id);
      Promise.resolve(api(`/api/packets/${r.id}/process?background=1`, { method: 'POST' })).catch(() => {});
    }
  }, [st.rows]);

  // Poll only while detection is pending: 2s, 3s, 5s, 8s, then every 10s; paused in background tabs; stops after ~3 min.
  const pending = (st.rows || []).some((r) => isPendingStatus(r.status));
  useEffect(() => {
    if (!pending) return;
    let n = 0, t = null, live = true; const start = Date.now();
    const tick = async () => {
      if (!live || Date.now() - start > POLL_MAX_MS) return;
      if (!document.hidden) await load().catch(() => {});
      if (live) t = setTimeout(tick, pollDelay(++n));
    };
    t = setTimeout(tick, pollDelay(0));
    const onVis = () => { if (!document.hidden && live) { clearTimeout(t); n = 0; tick(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { live = false; clearTimeout(t); document.removeEventListener('visibilitychange', onVis); };
  }, [pending, load]);

  async function onFile(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const v = validatePacketFile(f); if (v) return setMsg(v);
    setBusy(true); setMsg(null);
    let newId = null;
    const err = await uploadPacket(getSupabase(), { userId: user.current.id, ownerId: st.ownerId || user.current.id, file: f, onCreated: (id) => { newId = id; } });
    if (!err && newId) { // start field detection in the background; the packet page also retries it
      const { data } = await getSupabase().auth.getSession();
      kicked.current.add(newId);
      fetch(`/api/packets/${newId}/process?background=1`, { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${data?.session?.access_token}` } }).then(() => load(), () => {}); // runs server-side after the reply; polling picks up the result
    }
    setBusy(false);
    if (err) setMsg(err); else { setMsg('Packet uploaded.'); load(); }
  }

  async function setArchivedFlag(r, flag) {
    setRowBusy(r.id); setMsg(null);
    const d = await api(`/api/packets/${r.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: flag }) });
    setRowBusy(null);
    if (d.error) return setMsg(d.error);
    setMsg(flag ? 'Packet archived. Find it under Archived.' : 'Packet moved back to your list.');
    await Promise.all([load(), filter === 'archived' ? loadArchived() : setArchived(null)]);
  }
  async function del(r) {
    const name = r.subject || r.original_filename || 'this packet';
    if (!window.confirm(`Delete “${name}”?\n\nThis removes the PDF, filled copies, signatures and send history. It can’t be undone.`)) return;
    setRowBusy(r.id); setMsg(null);
    const d = await api(`/api/packets/${r.id}`, { method: 'DELETE' });
    setRowBusy(null);
    if (d.error) return setMsg(d.error);
    setMsg(d.storageWarning || 'Packet deleted.');
    await Promise.all([load(), filter === 'archived' ? loadArchived() : setArchived(null)]);
  }

  if (st.loading) return <main style={s.main}><h1 style={{ marginBottom: '0.25rem' }}>Carrier packets</h1><p style={s.muted}>Loading packets…</p></main>;
  if (st.error) return <main style={s.main}><h1>Carrier packets</h1><p role="alert" style={{ color: '#b91c1c' }}>{st.error}</p>{st.signedOut && <a href="/login?next=/packets">Sign in</a>}</main>;
  const counts = { ...filterCounts(st.rows), archived: archived ? archived.length : st.archivedCount };
  const shown = filter === 'archived' ? (archived || []) : filterPackets(st.rows, filter);
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
      <div role="tablist" aria-label="Filter packets" style={{ display: 'flex', gap: 6, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4, marginBottom: '0.75rem' }}>
        {PACKET_FILTERS.map((f) => <button key={f.id} role="tab" aria-selected={filter === f.id} style={s.tab(filter === f.id)} onClick={() => setFilter(f.id)}>{f.label}{counts[f.id] != null ? ` (${counts[f.id]})` : ''}</button>)}
      </div>
      {st.stale && <p style={{ ...s.muted, margin: '0 0 0.5rem' }} aria-live="polite">Updating…</p>}
      {st.refreshError && <p role="alert" style={{ color: '#b91c1c', fontSize: 14, margin: '0 0 0.5rem' }}>Couldn’t refresh: {st.refreshError}</p>}
      {filter === 'archived' && !archived ? <p style={s.muted}>Loading archived packets…</p>
        : shown.length === 0 ? <p style={s.muted}>{st.rows.length === 0 && filter === 'all' ? 'No packets yet.' : filter === 'archived' ? 'No archived packets.' : 'No packets here.'}</p>
        : shown.map((r) => (
          <div key={r.id} data-testid="packet-row" style={s.card}>
            <a href={`/packets/${r.id}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{r.subject || r.original_filename}</span>
                <span style={s.chip(r.color)} data-status={r.display}>{r.label}</span>
              </div>
              <p style={s.muted}>{r.source === 'email' ? 'Emailed' : 'Uploaded'} · {formatListTime(r.created_at)}{r.sent_at ? ` · Sent ${formatListTime(r.sent_at)}` : r.filled_at ? ` · Filled ${formatListTime(r.filled_at)}` : ''}</p>
              {r.hint && <p style={s.hint}>{r.hint}</p>}
            </a>
            {r.canManage && <div style={{ display: 'flex', gap: 8, marginTop: '0.6rem' }}>
              {r.display === 'archived'
                ? <button style={s.act} disabled={rowBusy === r.id} onClick={() => setArchivedFlag(r, false)}>Unarchive</button>
                : !isPendingStatus(r.status) && <button style={s.act} disabled={rowBusy === r.id} onClick={() => setArchivedFlag(r, true)}>Archive</button>}
              <button style={{ ...s.act, color: '#b91c1c', borderColor: '#fca5a5' }} disabled={rowBusy === r.id} onClick={() => del(r)}>Delete</button>
            </div>}
          </div>
        ))}
    </main>
  );
}
