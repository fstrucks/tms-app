'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from './supabase';

// Convention only; the DB column is free text.
export const SOURCES = ['loaded', 'deadhead', 'personal', 'other'];

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const fmtMiles = (n) => `${Number(n || 0).toLocaleString('en-US')} mi`;
export { fmtPerMile as fmtRpm } from './money';
export const fmtEntryDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export function sumBy(entries, pred = () => true) {
  return entries.filter(pred).reduce((t, e) => t + (Number(e.miles) || 0), 0);
}

// Generic user-facing message; details go to console.error at the call site.
export function mileageError() {
  return 'Could not save, please try again.';
}

const PAGE = 20;
const loadLabel = (x) => [x.broker_load_number && `#${x.broker_load_number}`, x.broker_name].filter(Boolean).join(' · ')
  || `Load ${new Date(x.created_at).toLocaleDateString()}`;

// Searchable load picker: ilike on broker_load_number / broker_name, newest first, with "load more".
export function LoadPicker({ value, onChange, style }) {
  const supabase = getSupabase();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [limit, setLimit] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setLimit(PAGE); }, [q]);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      let query = supabase.from('loads').select('id, broker_load_number, broker_name, created_at')
        .order('created_at', { ascending: false }).range(0, limit); // one extra row to detect "more"
      const term = q.trim().replace(/[%_,()*\\]/g, ' ').trim();
      if (term) query = query.or(`broker_load_number.ilike.%${term}%,broker_name.ilike.%${term}%`);
      const { data, error } = await query;
      if (cancelled) return;
      setBusy(false);
      if (error) { console.error('load search', error); setFailed(true); return; }
      setFailed(false);
      setHasMore((data || []).length > limit);
      setRows((data || []).slice(0, limit));
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, limit]);

  return (
    <div>
      <input type="search" placeholder="Search load # or broker" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ ...style, marginBottom: '0.4rem' }} />
      <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
        <option value="">No load</option>
        {rows.map((l) => <option key={l.id} value={l.id}>{loadLabel(l)}</option>)}
      </select>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>
        <span>{failed ? 'Could not load loads.' : busy ? 'Searching…' : `${rows.length} shown`}</span>
        {hasMore && <button type="button" data-compact onClick={() => setLimit((n) => n + PAGE)}
          style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.85rem', minHeight: 36, padding: '0 0.75rem' }}>Load more</button>}
      </div>
    </div>
  );
}

const st = {
  input: { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #6b7280', background: '#fff', color: '#111827', colorScheme: 'light' },
  cell: { display: 'block', minWidth: 0 },
  label: { display: 'block', fontSize: '0.85rem', color: '#374151', marginBottom: '0.25rem' },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0.6rem' },
  btn: { width: '100%', padding: '0.8rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem' },
  tab: (on) => ({ flex: 1, padding: '0.5rem', borderRadius: 8, border: '1px solid #d1d5db', background: on ? '#2563eb' : '#fff', color: on ? '#fff' : '#111', fontSize: '0.9rem' }),
};

// onSubmit(row) must return { error } like supabase-js.
export function MileageForm({ onSubmit, pickLoad = false }) {
  const [mode, setMode] = useState('odometer');
  const [date, setDate] = useState(todayISO());
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [miles, setMiles] = useState('');
  const [source, setSource] = useState('loaded');
  const [loadId, setLoadId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const int = (v) => (v === '' ? null : Number(v));
  const computed = mode === 'odometer' && start !== '' && end !== '' ? int(end) - int(start) : null;

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    const row = { entry_date: date, source, notes: notes.trim() || null };
    if (pickLoad) row.load_id = loadId || null;
    if (mode === 'odometer') {
      const s = int(start), en = int(end);
      if (!Number.isInteger(s) || !Number.isInteger(en) || s < 0) return setErr('Enter whole-number start and end odometer readings.');
      if (en < s) return setErr('End odometer must be greater than or equal to start.');
      if (en - s <= 0) return setErr('Miles must be greater than 0.');
      Object.assign(row, { start_odometer: s, end_odometer: en, miles: en - s });
    } else {
      const m = int(miles);
      if (!Number.isInteger(m) || m <= 0) return setErr('Miles must be a whole number greater than 0.');
      Object.assign(row, { start_odometer: null, end_odometer: null, miles: m });
    }
    setSaving(true);
    try {
      const { error } = await onSubmit(row);
      if (error) { console.error('mileage insert', error); return setErr(mileageError(error)); }
      setStart(''); setEnd(''); setMiles(''); setNotes('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <button type="button" style={st.tab(mode === 'odometer')} onClick={() => setMode('odometer')}>Odometer</button>
        <button type="button" style={st.tab(mode === 'miles')} onClick={() => setMode('miles')}>Miles</button>
      </div>
      <div style={st.grid} className="form-grid-2">
        <label style={st.cell}><span style={st.label}>Date</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} style={{ ...st.input, textAlign: 'left' }} /></label>
        <label style={st.cell}><span style={st.label}>Type</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={st.input}>
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select></label>
        {mode === 'odometer' ? (
          <>
            <label style={st.cell}><span style={st.label}>Start odometer</span>
              <input inputMode="numeric" pattern="[0-9]*" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ''))} style={st.input} /></label>
            <label style={st.cell}><span style={st.label}>End odometer</span>
              <input inputMode="numeric" pattern="[0-9]*" value={end} onChange={(e) => setEnd(e.target.value.replace(/\D/g, ''))} style={st.input} /></label>
          </>
        ) : (
          <label style={{ gridColumn: '1 / -1' }}><span style={st.label}>Miles</span>
            <input inputMode="numeric" pattern="[0-9]*" value={miles} onChange={(e) => setMiles(e.target.value.replace(/\D/g, ''))} style={st.input} /></label>
        )}
        {pickLoad && (
          <div style={{ gridColumn: '1 / -1' }}><span style={st.label}>Load (optional)</span>
            <LoadPicker value={loadId} onChange={setLoadId} style={st.input} /></div>
        )}
        <label style={{ gridColumn: '1 / -1' }}><span style={st.label}>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={st.input} /></label>
      </div>
      {mode === 'odometer' && computed !== null && (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: computed > 0 ? '#15803d' : '#b91c1c' }}>
          {computed > 0 ? `= ${fmtMiles(computed)}` : 'End must be greater than start'}
        </p>
      )}
      {err && <p style={{ color: '#b91c1c', margin: '0.5rem 0 0' }}>{err}</p>}
      <div style={{ position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', zIndex: 10, background: '#fff', padding: '0.6rem 0 0.4rem' }}>
        <button type="submit" disabled={saving} style={{ ...st.btn, width: '100%', minHeight: 48, marginTop: 0, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Add miles'}</button>
      </div>
    </form>
  );
}

export function EntryRow({ e, onDelete, loadLink }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0', borderBottom: '1px solid #f1f5f9' }}>
      <div style={{ minWidth: 0 }}>
        <div><strong>{fmtMiles(e.miles)}</strong> <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>· {e.source || '—'} · {fmtEntryDate(e.entry_date)}</span></div>
        {e.start_odometer != null && e.end_odometer != null && (
          <div style={{ color: '#6b7280', fontSize: '0.8rem' }}>Odo {e.start_odometer.toLocaleString()} → {e.end_odometer.toLocaleString()}</div>
        )}
        {loadLink}
        {e.notes && <div style={{ color: '#6b7280', fontSize: '0.8rem', wordBreak: 'break-word' }}>{e.notes}</div>}
      </div>
      <button onClick={() => window.confirm('Delete this entry?') && onDelete(e)}
        style={{ background: 'none', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, padding: '0.35rem 0.7rem', fontSize: '0.85rem' }}>Delete</button>
    </div>
  );
}
