'use client';
// Owner-only Bug reports list. The API decides access (404 for non-owners); this page shows "Page not found" then.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '../lib/supabase';
import { deviceLabel } from '../lib/bugReportsAdmin';

const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };
const STATUS = { new: ['New', 'var(--info-bg)', 'var(--primary)'], seen: ['Seen', 'var(--divider)', 'var(--text)'], fixed: ['Fixed', 'var(--success-bg)', 'var(--success)'], wont_fix: ['Won’t fix', 'var(--divider)', 'var(--text-muted)'] };
const s = {
  main: { padding: '1rem var(--gutter, 1rem)', fontFamily: 'system-ui', maxWidth: 900, margin: '0 auto' },
  card: { background: 'var(--surface)', border: '1px solid var(--divider)', borderRadius: 12, padding: '0.85rem 1rem', marginBottom: 10 },
  meta: { color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word' },
  label: { fontWeight: 600, fontSize: 13, color: 'var(--text-muted)', margin: '0.5rem 0 0.1rem' },
};

export default function BugReportsPage() {
  const supabase = getSupabase();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!supabase) return setState({ error: 'Supabase is not configured.' });
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      const t = data?.session?.access_token;
      if (!t) return alive && setState({ signedOut: true });
      try {
        const res = await fetch('/api/bug-reports', { headers: { authorization: `Bearer ${t}` }, cache: 'no-store' });
        const j = await res.json().catch(() => ({}));
        if (!alive) return;
        if (res.status === 404 || res.status === 403) return setState({ notFound: true });
        if (!res.ok) return setState({ error: j.error || 'Could not load bug reports.' });
        setState({ reports: j.reports || [], setupNeeded: !!j.setupNeeded, note: j.error });
      } catch { if (alive) setState({ error: 'No connection. Try again.' }); }
    });
    return () => { alive = false; };
  }, []);

  if (state.loading) return <main style={s.main}><p style={s.meta}>Loading…</p></main>;
  if (state.notFound) return <main style={s.main} data-testid="bug-reports-404"><h1>Page not found</h1><p><Link href="/">Go home</Link></p></main>;
  if (state.signedOut) return <main style={s.main}><h1>Bug reports</h1><p><Link href="/login?next=/bug-reports">Sign in</Link> to see bug reports.</p></main>;
  return (
    <main style={s.main} data-testid="bug-reports-page">
      <h1 style={{ margin: '0.25rem 0 0.25rem' }}>Bug reports</h1>
      <p style={{ ...s.meta, marginTop: 0 }}>From you and your testers, newest first. Only you (the company owner) can see this page.</p>
      {state.error && <p role="alert" style={{ color: 'var(--danger)' }}>{state.error}</p>}
      {state.setupNeeded && <p data-testid="bug-reports-setup" style={{ background: 'var(--warning-bg)', color: 'var(--warning)', padding: '0.7rem 0.9rem', borderRadius: 10 }}>{state.note || 'Bug reports aren’t switched on yet.'}</p>}
      {state.reports && !state.reports.length && !state.setupNeeded && <p style={s.meta}>No bug reports yet.</p>}
      {(state.reports || []).map((r) => {
        const [lbl, bg, fg] = STATUS[r.status] || STATUS.new;
        let path = r.page_url; try { const u = new URL(r.page_url); path = u.pathname + u.search; } catch { /* keep raw */ }
        return (
          <article key={r.id} style={s.card} data-testid="bug-report-row">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ wordBreak: 'break-all' }}>{r.user_email || 'Unknown tester'}</strong>
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <span style={{ padding: '1px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{lbl}</span>
                <span style={s.meta}>{fmt(r.created_at)}</span>
              </span>
            </div>
            <div style={s.label}>What happened</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{r.what_happened}</div>
            {r.expected && <><div style={s.label}>Expected</div><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{r.expected}</div></>}
            <div style={{ ...s.meta, marginTop: 8 }}>
              Page: {r.page_url ? <a href={path.startsWith('/') && !path.startsWith('//') ? path : undefined} title={r.page_url} style={{ color: 'var(--primary)' }}>{path}</a> : '—'}<br />
              Device: {deviceLabel(r.user_agent || '')}{r.viewport ? ` · ${r.viewport}` : ''}
              <details style={{ display: 'inline' }}><summary style={{ display: 'inline', cursor: 'pointer', color: 'var(--primary)', marginLeft: 6 }}>user agent</summary><div>{r.user_agent}</div></details>
            </div>
            {r.screenshot_url && <a href={r.screenshot_url} target="_blank" rel="noopener noreferrer" data-testid="bug-report-shot"
              style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, marginTop: 4, color: 'var(--primary)', fontWeight: 600 }}>View screenshot (link expires in 10 min)</a>}
            {r.has_screenshot && !r.screenshot_url && <div style={{ ...s.meta, marginTop: 6 }}>Screenshot attached, but the link couldn’t be created. Reload to try again.</div>}
          </article>
        );
      })}
    </main>
  );
}
