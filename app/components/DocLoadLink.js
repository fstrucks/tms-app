'use client';
// Documents tab: "Load" picker for load paperwork (BOL, POD, lumper receipt, scale ticket). Suggests the matching
// load (number on the document, then your active load, then the date) and lets you pick or change it.
// Fresh uploads (last 2 days) ask for a suggestion right away; older ones on "Link to load".
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SUGGEST_REASON } from '../lib/loadDocs';

const RECENT_MS = 2 * 864e5;
async function tokenOf(supabase) { const { data } = await supabase.auth.getSession(); return data?.session?.access_token || ''; }

export default function DocLoadLink({ supabase, doc, onLinked }) {
  const [open, setOpen] = useState(!doc.load_id && Date.now() - Date.parse(doc.created_at) < RECENT_MS);
  const [st, setSt] = useState({ state: 'idle' });
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open || st.state !== 'idle') return;
    let live = true;
    setSt({ state: 'loading' });
    (async () => {
      try {
        const res = await fetch(`/api/documents/${doc.id}/suggest-load`, { cache: 'no-store', headers: { Authorization: `Bearer ${await tokenOf(supabase)}` } });
        const j = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) return setSt({ state: 'error', error: j.error || 'Couldn’t load your loads.' });
        setSt({ state: 'ready', ...j });
        setPick(doc.load_id || j.suggestion?.loadId || '');
      } catch { if (live) setSt({ state: 'error', error: 'Couldn’t reach the server.' }); }
    })();
    return () => { live = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setSaving(true); setErr(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/load`, { method: 'PATCH', cache: 'no-store', headers: { Authorization: `Bearer ${await tokenOf(supabase)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ loadId: pick || null }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(j.error || 'Couldn’t link the document.');
      onLinked?.(j.document?.load_id || null);
      setOpen(false);
    } catch { setErr('Couldn’t reach the server. Not linked.'); } finally { setSaving(false); }
  }

  if (!open) {
    return (
      <div data-testid="doc-load-link" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {doc.load_id && <Link href={`/loads/${doc.load_id}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: 'var(--primary)' }}>View load</Link>}
        <button type="button" data-testid="doc-load-open" onClick={() => setOpen(true)} style={{ minHeight: 44, background: 'none', border: 'none', color: 'var(--primary)', padding: 0, fontSize: '0.9rem' }}>
          {doc.load_id ? 'Change load' : 'Link to load'}
        </button>
      </div>
    );
  }
  const sug = st.suggestion;
  return (
    <div data-testid="doc-load-link" style={{ marginTop: 6 }}>
      {st.state === 'loading' && <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>Finding the matching load…</p>}
      {st.state === 'error' && <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{st.error}</p>}
      {st.state === 'ready' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
            <span>Load</span>
            <select data-testid="doc-load-select" value={pick} onChange={(e) => setPick(e.target.value)} disabled={saving}
              style={{ flex: 1, minWidth: 0, minHeight: 44, fontSize: 15, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <option value="">No load</option>
              {st.loads.map((l) => <option key={l.id} value={l.id}>{l.label}{sug?.loadId === l.id ? ' (suggested)' : ''}</option>)}
            </select>
          </label>
          {sug && <p data-testid="doc-load-suggested" style={{ color: 'var(--text-muted)', fontSize: 12, margin: '2px 0 0' }}>Suggested: {SUGGEST_REASON[sug.reason]}.</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" data-testid="doc-load-save" onClick={save} disabled={saving || pick === (doc.load_id || '')}
              style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary, #fff)', fontWeight: 600, opacity: saving || pick === (doc.load_id || '') ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setOpen(false)} style={{ minHeight: 44, background: 'none', border: 'none', color: 'var(--primary)' }}>Cancel</button>
          </div>
        </>
      )}
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: '4px 0 0' }}>{err}</p>}
    </div>
  );
}
