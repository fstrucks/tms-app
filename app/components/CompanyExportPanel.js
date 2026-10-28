'use client';
// Danger zone: "Export company data" for the company owner. DangerZone renders this only when role is owner;
// the routes check ownership again. Starting an export emails the owner a link when it is ready.
import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { exportErrorText, pollDelayMs, shouldPoll, statusLine } from '../lib/companyExportCopy';

const btn = {
  width: '100%', minHeight: 44, padding: '0.85rem', fontSize: '1rem', borderRadius: 8, marginTop: '0.75rem', cursor: 'pointer',
  background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
};

async function call(method, body) {
  const sb = getSupabase();
  const { data } = await sb.auth.getSession();
  const access = data?.session?.access_token || '';
  if (!access) return { res: { ok: false, status: 401 }, body: { error: 'Sign in first.' } };
  const res = await fetch('/api/company-export', {
    method, cache: 'no-store',
    headers: { authorization: `Bearer ${access}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

export default function CompanyExportPanel() {
  const [job, setJob] = useState(undefined); // undefined = loading, null = none yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [link, setLink] = useState(null);
  const pollStart = useRef(0);

  async function refresh() {
    const { res, body } = await call('GET');
    if (!res.ok) { setError(body.error || 'Couldn’t load the export status.'); if (job === undefined) setJob(null); return null; }
    setJob(body.job || null);
    return body.job || null;
  }

  useEffect(() => { refresh().catch(() => setError('Couldn’t load the export status.')); }, []);

  // Poll while a job is open: 5 s for a minute, then 15 s; skip while the tab is hidden.
  useEffect(() => {
    if (!shouldPoll(job)) return undefined;
    if (!pollStart.current) pollStart.current = Date.now();
    const t = setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) { setJob((j) => (j ? { ...j } : j)); return; }
      refresh().catch(() => {});
    }, pollDelayMs(Date.now() - pollStart.current));
    return () => clearTimeout(t);
  }, [job]);

  async function start() {
    setBusy(true); setError(null); setLink(null);
    try {
      const { res, body } = await call('POST', {});
      if (!res.ok) { setError(exportErrorText(res, body)); return; }
      pollStart.current = Date.now();
      await refresh();
    } catch { setError('Couldn’t reach the server. Try again.'); } finally { setBusy(false); }
  }

  async function freshLink() {
    setBusy(true); setError(null);
    try {
      const { res, body } = await call('POST', { action: 'link' });
      if (!res.ok || !body.url) { setError(body.error || 'Couldn’t make a link. Try again.'); return; }
      setLink(body.url);
    } catch { setError('Couldn’t reach the server. Try again.'); } finally { setBusy(false); }
  }

  const open = shouldPoll(job);
  const ready = job?.status === 'ready';
  return (
    <div data-testid="company-export" style={{ borderBottom: '1px solid var(--danger-border)', paddingBottom: '1rem', marginBottom: '1rem' }}>
      <h3 style={{ fontSize: '1rem', margin: '0 0 0.35rem' }}>Export company data</h3>
      <p style={{ margin: '0.25rem 0' }}>Download a full copy of the company’s records and uploaded documents. When it is ready, a download link is emailed to you. The link needs no sign-in.</p>
      {job === undefined && <p>Loading…</p>}
      {job && <p role="status" data-testid="company-export-status">{statusLine(job)}</p>}
      {ready && !link && (
        <button type="button" data-testid="company-export-link" disabled={busy} onClick={freshLink} style={btn}>
          {busy ? 'Getting link…' : 'Get a fresh link'}
        </button>
      )}
      {ready && link && (
        <p><a href={link} rel="noreferrer nofollow" style={{ color: 'var(--primary)', fontWeight: 600 }}>Open the download page</a>. This new link replaces the one in the email. Don’t share it.</p>
      )}
      {!open && job !== undefined && (
        <button type="button" data-testid="company-export-start" disabled={busy} onClick={start} style={btn}>
          {busy && !ready ? 'Starting…' : 'Download full export'}
        </button>
      )}
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
