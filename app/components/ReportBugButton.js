'use client';
// Floating "Report a bug" button (every signed-in page) + short form. Saves to bug_reports via /api/bug-reports;
// optional screenshot goes to the documents bucket under <uid>/bug-reports/. Logic: app/lib/bugReport.js.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getSupabase } from '../lib/supabase';
import { captureContext, checkScreenshot, screenshotPath, isBugButtonHidden, SETUP_MSG } from '../lib/bugReport';

const field = { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 8, padding: '0.6rem 0.7rem', fontSize: 16, fontFamily: 'inherit' };
const label = { display: 'block', fontWeight: 600, margin: '0.75rem 0 0.3rem' };

export default function ReportBugButton() {
  const supabase = getSupabase();
  const pathname = usePathname();
  const [session, setSession] = useState(null);
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('');
  const [expected, setExpected] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'error'|'ok'|'setup', text }
  const [wide, setWide] = useState(false);
  const firstRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!supabase) return undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s || null));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { const m = window.matchMedia('(min-width: 768px)'); const f = () => setWide(m.matches); f(); m.addEventListener?.('change', f); return () => m.removeEventListener?.('change', f); }, []);
  useEffect(() => {
    if (!open) return undefined;
    firstRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && !busy) setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy]);

  if (!session?.user || isBugButtonHidden(pathname)) return null;
  const ctx = typeof window === 'undefined' ? {} : captureContext(window);

  function pick(e) {
    const f = e.target.files?.[0] || null; const bad = checkScreenshot(f);
    if (bad) { setMsg({ kind: 'error', text: bad }); setFile(null); if (fileRef.current) fileRef.current.value = ''; return; }
    setMsg(null); setFile(f);
  }

  async function submit(e) {
    e.preventDefault();
    if (!what.trim()) { setMsg({ kind: 'error', text: 'Please say what happened.' }); firstRef.current?.focus(); return; }
    setBusy(true); setMsg(null);
    let note = '';
    try {
      const uid = session.user.id;
      let shot = null;
      if (file) {
        const path = screenshotPath(uid, file);
        const { error } = await supabase.storage.from('documents').upload(path, file, { contentType: file.type, upsert: false });
        if (error) { console.warn('[bug] screenshot upload', error); note = ' (The screenshot couldn’t be uploaded, but your report was sent.)'; } else shot = path;
      }
      const res = await fetch('/api/bug-reports', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ what_happened: what, expected, screenshot_path: shot, ...captureContext(window) }) });
      const j = await res.json().catch(() => ({}));
      if (j.setupNeeded) { setMsg({ kind: 'setup', text: j.error || SETUP_MSG }); return; }
      if (!res.ok) { setMsg({ kind: 'error', text: j.error || 'Couldn’t send your report. Please try again.' }); return; }
      setWhat(''); setExpected(''); setFile(null); if (fileRef.current) fileRef.current.value = '';
      setMsg({ kind: 'ok', text: `Thanks! Your report reached the team.${note}` });
    } catch (err) {
      console.error('[bug] submit', err); setMsg({ kind: 'error', text: 'No connection. Check your signal and try again. Your words are still here.' });
    } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" data-testid="report-bug-button" onClick={() => { setOpen(true); setMsg(null); }}
        style={{ position: 'fixed', right: 12, bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom) + 12px)', zIndex: 60, minHeight: 40, padding: '0 0.85rem',
          border: '1px solid #e2e8f0', borderRadius: 999, background: '#fff', color: '#334155', fontSize: 14, fontWeight: 600, fontFamily: 'system-ui',
          boxShadow: '0 4px 14px rgba(15,23,42,0.15)', cursor: 'pointer', display: open ? 'none' : 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden="true">🐞</span>Report a bug
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="bug-title" data-testid="report-bug-dialog"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: wide ? 'center' : 'flex-end', justifyContent: 'center', padding: wide ? 24 : 0, fontFamily: 'system-ui' }}>
          <form onSubmit={submit} noValidate
            style={{ width: '100%', maxWidth: 520, maxHeight: '92dvh', overflowY: 'auto', background: '#fff', borderRadius: wide ? 16 : '16px 16px 0 0', padding: '1rem 1rem calc(1rem + env(safe-area-inset-bottom))', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 id="bug-title" style={{ margin: 0, fontSize: '1.25rem' }}>Report a bug</h2>
              <button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}
                style={{ minWidth: 44, minHeight: 44, border: 'none', background: 'transparent', fontSize: 24, cursor: 'pointer', color: '#475569' }}>×</button>
            </div>
            <label htmlFor="bug-what" style={label}>What happened?</label>
            <textarea id="bug-what" ref={firstRef} required rows={3} maxLength={4000} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="I tapped Save on the load and…" style={field} />
            <label htmlFor="bug-expected" style={label}>What did you expect? <span style={{ fontWeight: 400, color: '#64748b' }}>(optional)</span></label>
            <textarea id="bug-expected" rows={2} maxLength={4000} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="It should have saved and gone back to Loads." style={field} />
            <label htmlFor="bug-shot" style={label}>Screenshot <span style={{ fontWeight: 400, color: '#64748b' }}>(optional)</span></label>
            <input id="bug-shot" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" onChange={pick} style={{ fontSize: 16, maxWidth: '100%' }} />
            <p data-testid="bug-context" style={{ margin: '0.75rem 0 0', fontSize: 13, color: '#64748b', lineHeight: 1.4, wordBreak: 'break-word' }}>
              We’ll also include this page ({pathname}), your device and browser ({ctx.viewport}), and your email ({session.user.email}).
            </p>
            {msg && <p role={msg.kind === 'ok' ? 'status' : 'alert'} data-testid="bug-msg"
              style={{ margin: '0.75rem 0 0', padding: '0.6rem 0.75rem', borderRadius: 8, background: msg.kind === 'ok' ? '#ecfdf5' : msg.kind === 'setup' ? '#fffbeb' : '#fef2f2', color: msg.kind === 'ok' ? '#065f46' : msg.kind === 'setup' ? '#92400e' : '#b91c1c' }}>{msg.text}</p>}
            <button type="submit" disabled={busy} data-testid="bug-submit"
              style={{ width: '100%', minHeight: 48, marginTop: '0.9rem', border: 'none', borderRadius: 10, background: busy ? '#93c5fd' : '#2563eb', color: '#fff', fontSize: '1rem', fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'Sending…' : 'Send report'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
