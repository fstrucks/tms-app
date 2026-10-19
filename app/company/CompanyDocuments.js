'use client';
// Company page → Company documents (PR #84). Four rows: W-9, COI, MC Authority, NOA. Newest upload is current (1A).
// Owner + management upload, replace and delete. Dispatchers and drivers see on-file status only for all four
// (2C, widened by Marc Oct 18): the server never sends them those files' details, so there is nothing to hide here, only less to show.
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import UploadMenu from '../components/UploadMenu';
import ConfirmButton from '../components/ui/ConfirmButton';
import { checkVaultUpload, deleteCurrentPrompt, VAULT_TYPES, INSURANCE_CHANGED_EVENT, VAULT_CHANGED_EVENT } from '../lib/companyDocs';

const Scanner = dynamic(() => import('../components/scanner/Scanner'), { ssr: false, loading: () => null });
const { call: api } = makeApi(() => getSupabase()?.auth);
const URL_ = '/api/company/documents';
const COLORS = { ok: { bg: '#dcfce7', fg: '#166534', icon: '✓' }, warn: { bg: '#fef3c7', fg: '#92400e', icon: '⚠' }, bad: { bg: '#fee2e2', fg: '#b91c1c', icon: '✕' } };
const s = {
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  row: { border: '1px solid #e5e7eb', borderRadius: 10, padding: '0.75rem', marginTop: '0.75rem' },
  muted: { color: '#6b7280', fontSize: 14 },
  btn: { minHeight: 44, padding: '0 0.9rem', fontSize: 15, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' },
  err: { color: '#b91c1c', fontSize: 14, margin: '0.4rem 0 0' },
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const guessType = (f) => (f?.type || (/\.pdf$/i.test(f?.name || '') ? 'application/pdf' : /\.png$/i.test(f?.name || '') ? 'image/png' : /\.jpe?g$/i.test(f?.name || '') ? 'image/jpeg' : '')).toLowerCase();

export function Pill({ status }) {
  const c = COLORS[status?.level] || COLORS.bad;
  return <span data-testid="vault-pill" style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: c.bg, color: c.fg, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{c.icon} {status?.text || 'Missing'}</span>;
}

// Preview-only build tag (#89 QA) so testers can tell which commit their open tab is running.
const BUILD = process.env.NEXT_PUBLIC_VERCEL_ENV === 'preview' ? String(process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) : '';

export default function CompanyDocuments() {
  const [st, setSt] = useState({ loading: true });
  const [busy, setBusy] = useState(null); // type being uploaded
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState({}); // type → message
  const [scan, setScan] = useState(null); // { type, files }
  const [open, setOpen] = useState({}); // type → earlier versions shown

  const apply = useCallback((j) => { if (j.error) return setSt((x) => ({ ...x, loading: false, error: x.vault ? null : j.error })); setSt({ ...j, loading: false }); }, []);
  const reload = useCallback(() => api(URL_).then(apply), [apply]);
  useEffect(() => { reload(); }, [reload]);
  // (#89 QA) The COI row follows Insurance: re-read after any policy change there, no page reload needed.
  useEffect(() => { const h = () => reload(); window.addEventListener(INSURANCE_CHANGED_EVENT, h); return () => window.removeEventListener(INSURANCE_CHANGED_EVENT, h); }, [reload]);
  const changed = () => { try { window.dispatchEvent(new Event(VAULT_CHANGED_EVENT)); } catch { /* not in a browser */ } };
  // (#89 QA) An old error (e.g. "Use a PDF, JPEG or PNG file.") clears on the next pick or the next action that works.
  const clearErrors = () => setErr({});

  async function upload(type, file) {
    setMsg(null); clearErrors();
    const contentType = guessType(file);
    const bad = checkVaultUpload({ size: file?.size, contentType });
    if (bad) return setErr((e) => ({ ...e, [type]: bad }));
    setBusy(type);
    try {
      const start = await api(URL_, { method: 'POST', body: JSON.stringify({ action: 'start', docType: type, filename: file.name, size: file.size, contentType }) });
      if (start.error) return setErr((e) => ({ ...e, [type]: start.error }));
      const { error } = await getSupabase().storage.from('documents').uploadToSignedUrl(start.path, start.token, file, { contentType });
      if (error) return setErr((e) => ({ ...e, [type]: 'The upload didn’t finish. Check your connection and try again.' }));
      const done = await api(URL_, { method: 'POST', body: JSON.stringify({ action: 'finish', docType: type, path: start.path, filename: file.name }) });
      if (done.error) return setErr((e) => ({ ...e, [type]: done.error }));
      apply(done);
      clearErrors(); changed();
      setMsg(`Saved ${file.name}.`);
    } finally { setBusy(null); }
  }
  async function view(id) {
    const r = await api(`${URL_}?view=${encodeURIComponent(id)}`);
    if (r.error || !r.url) return setMsg(r.error || 'Couldn’t open the file.');
    clearErrors();
    window.open(r.url, '_blank', 'noopener');
  }
  async function remove(type, id) {
    const r = await api(`${URL_}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.error) { setErr((e) => ({ ...e, [type]: r.error })); return false; }
    apply(r);
    clearErrors(); changed();
    setMsg(r.warning || 'Deleted.');
    return true;
  }

  if (st.loading) return <section style={s.card} id="company-documents"><p>Loading company documents…</p></section>;
  if (st.error) return <section style={s.card} id="company-documents"><h2 style={{ margin: 0, fontSize: '1.1rem' }}>Company documents</h2><p role="alert" style={s.err}>{st.error}</p><button type="button" style={s.btn} onClick={reload}>Retry</button></section>;
  const rows = st.vault || [];
  const onFile = rows.filter((r) => r.onFile).length;
  return (
    <section style={s.card} id="company-documents" aria-label="Company documents" data-testid="company-documents">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Company documents</h2>
        <span style={s.muted}>{onFile} of {rows.length} on file</span>
      </div>
      <p style={{ ...s.muted, margin: '0.35rem 0 0' }}>Brokers ask for these with every packet. The newest upload of each is the one that's used.{st.canManage ? '' : ' Ask the owner or management to add or replace them.'}</p>
      {rows.map((r) => {
        const t = VAULT_TYPES.find((x) => x.id === r.type);
        return (
          <div key={r.type} id={`vault-${r.type}`} data-testid={`vault-row-${r.type}`} style={s.row} data-confirm-row>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong>{r.label}</strong>
              <Pill status={r.status} />
            </div>
            {r.restricted ? (
              <p data-testid="vault-restricted" style={{ ...s.muted, margin: '0.4rem 0 0' }}>Only the owner and management can open the {t?.short || r.label}.</p>
            ) : (
              <>
                {r.current && <p style={{ ...s.muted, margin: '0.4rem 0 0', wordBreak: 'break-word' }}>{r.current.original_filename} · uploaded {fmtDate(r.current.created_at)} · {r.status.expiryText}</p>}
                {r.status.note && <p style={{ fontSize: 14, color: r.status.level === 'bad' ? '#b91c1c' : '#92400e', margin: '0.35rem 0 0' }}>{r.status.note} <a href="#company-insurance" style={{ color: '#2563eb' }}>Go to Insurance ↓</a></p>}
                {r.type === 'coi' && !r.status.note && r.current && r.status.expiryText === 'Expiry not entered' && <p style={{ ...s.muted, margin: '0.35rem 0 0' }}>Enter the policy dates in <a href="#company-insurance" style={{ color: '#2563eb' }}>Insurance ↓</a> to track the expiry.</p>}
                {r.status.hint && <p style={{ ...s.muted, margin: '0.35rem 0 0' }}>{r.status.hint}</p>}
                <div className="vault-actions" data-testid="vault-actions">
                  {r.current && <button type="button" className="vault-btn" style={s.btn} onClick={() => view(r.current.id)} data-testid="vault-view">View</button>}
                  {st.canManage && (
                    <div className="vault-upload">
                      <UploadMenu label={busy === r.type ? 'Uploading…' : r.current ? 'Replace ▾' : 'Upload or scan ▾'} disabled={!!busy}
                        onFile={(f) => upload(r.type, f)} onScan={(files) => { clearErrors(); setScan({ type: r.type, files }); }} />
                    </div>
                  )}
                  {st.canManage && r.current && (<div className="vault-delete">
                    <ConfirmButton label="Delete" prompt={deleteCurrentPrompt({ type: r.type, label: r.label, earlier: r.earlier }, fmtDate)} onConfirm={() => remove(r.type, r.current.id)} />
                  </div>)}
                </div>
                {r.earlier?.length > 0 && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <button type="button" style={{ ...s.btn, border: 'none', padding: 0, color: '#2563eb', background: 'none' }} aria-expanded={!!open[r.type]} onClick={() => setOpen((o) => ({ ...o, [r.type]: !o[r.type] }))}>
                      {open[r.type] ? '▾' : '▸'} Earlier versions ({r.earlier.length})
                    </button>
                    {open[r.type] && r.earlier.map((d) => (
                      <div key={d.id} data-confirm-row style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0.4rem 0', borderTop: '1px solid #f1f5f9' }}>
                        <span style={{ ...s.muted, wordBreak: 'break-word' }}>{d.original_filename} · {fmtDate(d.created_at)}</span>
                        <span style={{ display: 'flex', gap: 8 }}>
                          <button type="button" style={s.btn} onClick={() => view(d.id)}>View</button>
                          {st.canManage && <ConfirmButton label="Delete" prompt={`Delete this earlier ${t?.short || r.label} (${fmtDate(d.created_at)})?`} onConfirm={() => remove(r.type, d.id)} />}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {err[r.type] && <p role="alert" style={s.err}>{err[r.type]}</p>}
          </div>
        );
      })}
      {msg && <p role="status" style={{ marginTop: '0.75rem', fontSize: 14 }}>{msg}</p>}
      {scan && (
        <Scanner initialFiles={scan.files} loads={[]} typeIds={[scan.type]} onClose={() => setScan(null)}
          onSave={async (sc) => { const type = scan.type; setScan(null); await upload(type, sc.file); return null; }} />
      )}
      {BUILD && <p data-testid="build-tag" style={{ color: '#9ca3af', fontSize: 12, margin: '0.75rem 0 0' }}>Preview build {BUILD}. If this doesn’t match the PR head, reload the page.</p>}
    </section>
  );
}
