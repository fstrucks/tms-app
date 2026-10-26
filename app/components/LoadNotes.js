'use client';
// Load notes: owner, management and dispatchers edit and press Save. Drivers never see this box.
import { useEffect, useState } from 'react';
import { canEditLoadNotes, saveLoadNotes, LOAD_NOTES_MAX } from '../lib/loadNotes';

export default function LoadNotes({ supabase, load, cardStyle, onSaved }) {
  const [text, setText] = useState(load?.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);
  useEffect(() => { setText(load?.notes || ''); }, [load?.id, load?.notes]);
  if (!canEditLoadNotes(load)) return null;
  const dirty = text.trim() !== String(load.notes || '').trim();

  async function save(e) {
    e.preventDefault();
    setErr(null); setOk(false); setBusy(true);
    try {
      const r = await saveLoadNotes(supabase, load.id, text);
      if (!r.ok) return setErr(r.error);
      setOk(true);
      onSaved?.({ notes: r.notes });
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} style={cardStyle} data-testid="load-notes-form">
      <label htmlFor="load-notes" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>Load notes</label>
      <textarea id="load-notes" data-testid="load-notes" value={text} maxLength={LOAD_NOTES_MAX} rows={4}
        onChange={(e) => { setText(e.target.value); setOk(false); }}
        style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: 16, padding: 8, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="submit" data-testid="load-notes-save" disabled={busy || !dirty}
          style={{ minHeight: 44, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600 }}>{busy ? 'Saving…' : 'Save'}</button>
        {ok && !dirty && <span role="status" style={{ color: 'var(--success)', fontSize: 14 }}>Saved.</span>}
        {err && <span role="alert" style={{ color: 'var(--danger)', fontSize: 14 }}>{err}</span>}
      </div>
    </form>
  );
}
