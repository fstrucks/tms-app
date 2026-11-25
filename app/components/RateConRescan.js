'use client';
// Load page → "Rescan rate con" (owner, load with a rate con). Reads the rate con again, shows exactly which EMPTY
// fields it would fill, and saves only after the user confirms. Fields that already have a value are never changed.
import { useState } from 'react';

const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.95rem', cursor: 'pointer' };
const primary = { ...btn, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600 };
const muted = { margin: 0, fontSize: '0.88rem', color: 'var(--text-muted)' };
const STOP = { pickup: 'Pickup', delivery: 'Delivery' };

export const showRescan = (owner, docs) => !!owner && (docs || []).some((d) => d.doc_type === 'rate_confirmation');

export default function RateConRescan({ supabase, load, docs, owner, cardStyle, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [preview, setPreview] = useState(null); // { scan, changes }
  const [accept, setAccept] = useState([]);
  const [done, setDone] = useState(null);
  if (!showRescan(owner, docs)) return null;

  const call = async (body) => {
    const token = (await supabase.auth.getSession()).data?.session?.access_token || '';
    const r = await fetch(`/api/loads/${load.id}/rescan-ratecon`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Couldn’t rescan the rate con. Please try again.');
    return j;
  };
  async function scan() {
    setBusy(true); setErr(null); setDone(null); setPreview(null);
    try { const j = await call({ mode: 'preview' }); setPreview(j); setAccept((j.changes || []).map((c) => c.key)); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr(null);
    try {
      const j = await call({ mode: 'apply', scan: preview.scan, accept });
      setPreview(null);
      setDone(j.applied?.length ? `Filled ${j.applied.length} empty field${j.applied.length === 1 ? '' : 's'}.` : 'Nothing changed: those fields already have values.');
      onSaved?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const toggle = (k) => setAccept((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  const changes = preview?.changes || [];

  return (
    <section style={cardStyle} data-testid="ratecon-rescan">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Rescan rate con</h2>
      <p style={muted}>Reads the rate con again and fills only fields that are empty. Nothing you entered is changed. Each rescan counts toward your scan limit.</p>
      {!preview && <button type="button" data-testid="ratecon-rescan-start" disabled={busy} onClick={scan} style={{ ...btn, marginTop: 10 }}>{busy ? 'Scanning…' : 'Rescan rate con'}</button>}
      {err && <p role="alert" style={{ ...muted, color: 'var(--danger)', marginTop: 8 }}>{err}</p>}
      {done && <p data-testid="ratecon-rescan-done" style={{ ...muted, marginTop: 8 }}>{done}</p>}
      {preview && (
        <div data-testid="ratecon-rescan-preview" style={{ marginTop: 10 }}>
          {changes.length === 0 ? <p style={muted}>Nothing to fill: every field the rate con has is already filled in.</p> : (
            <>
              <p style={{ ...muted, color: 'var(--text)' }}>Review what will be filled in:</p>
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
                {changes.map((c) => (
                  <li key={c.key} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input type="checkbox" checked={accept.includes(c.key)} onChange={() => toggle(c.key)} style={{ marginTop: 4 }} data-testid={`ratecon-rescan-pick-${c.key}`} />
                      <span>
                        <strong>{c.stopType ? `${STOP[c.stopType]} · ${c.label}` : c.label}</strong>
                        <span style={{ display: 'block', ...muted, whiteSpace: 'pre-line' }}>{c.from ? `Now: ${c.from}` : 'Now: empty'}</span>
                        <span style={{ display: 'block', whiteSpace: 'pre-line', fontSize: '0.92rem' }}>New: {c.to}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {changes.length > 0 && <button type="button" data-testid="ratecon-rescan-save" disabled={busy || !accept.length} onClick={save} style={primary}>{busy ? 'Saving…' : `Save ${accept.length} change${accept.length === 1 ? '' : 's'}`}</button>}
            <button type="button" data-testid="ratecon-rescan-cancel" disabled={busy} onClick={() => setPreview(null)} style={btn}>{changes.length ? 'Cancel' : 'Close'}</button>
          </div>
        </div>
      )}
    </section>
  );
}
