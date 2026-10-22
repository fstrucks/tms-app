'use client';
// Load page → "⬇ Stop times (PDF)": each stop's address and actual picked-up / delivered time (detention record).
import { useState } from 'react';

export default function StopTimesDownload({ supabase, load }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!load?.id || !(load.stops || []).length) return null;
  async function get() {
    setErr(null); setBusy(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* default zone */ }
      const r = await fetch(`/api/loads/${load.id}/stop-times?tz=${encodeURIComponent(tz)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${s?.session?.access_token || ''}` } });
      if (!r.ok) throw new Error('dl');
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'StopTimes.pdf';
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { setErr('Couldn’t download the stop times. Please try again.'); }
    setBusy(false);
  }
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" data-testid="stop-times-pdf" disabled={busy} onClick={get}
        style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.95rem', cursor: 'pointer' }}>
        {busy ? 'Building…' : '⬇ Stop times (PDF)'}</button>
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
