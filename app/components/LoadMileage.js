'use client';

import { useEffect, useState } from 'react';
import { getSupabase, hasSession } from '../lib/supabase';
import { LoadError } from './DataState';
import { fmtMoney } from '../lib/loads';
import { MileageForm, EntryRow, sumBy, fmtMiles, fmtRpm } from '../lib/mileage';
import { writeLoadMiles, milesSourceNote, hasMilesSourceColumn, extractedMiles } from '../lib/loadMiles';

const card = { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' };
const row = { display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', fontSize: '0.9rem' };
const muted = { color: '#6b7280' };
const input = { width: '100%', boxSizing: 'border-box', padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' };

// Miles section for one load. onLoadChange receives { total_miles, rate_per_mile[, miles_source] } after the DB recalculates.
// Planned miles (loads.total_miles: rate con or typed; a typed value always wins) are shown with a small grey source
// note. The mileage log total is shown separately as "actual" (Sam/Marc, Oct 18) and does not replace planned miles
// once 20261018000300_load_miles_source.sql has run. Before that, the old trigger still copies the log total in.
export default function LoadMileage({ load, userId, onLoadChange }) {
  const supabase = getSupabase();
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [manual, setManual] = useState(load.total_miles ?? '');
  const [savingManual, setSavingManual] = useState(false);
  const [rateConMiles, setRateConMiles] = useState(null);
  const [migrated, setMigrated] = useState(hasMilesSourceColumn(load));

  const pick = (l) => ({ total_miles: l.total_miles, rate_per_mile: l.rate_per_mile, ...(hasMilesSourceColumn(l) ? { miles_source: l.miles_source } : {}) });

  async function refresh() {
    setError(null);
    // No session -> the query would silently return [] (RLS) and show 0 mi; show an error with Retry instead.
    if (!(await hasSession(supabase))) return setError('Your session has expired or is still loading. Tap Retry, or sign in again.');
    const [{ data, error }, { data: l }, { data: rc }] = await Promise.all([
      supabase.from('mileage_entries')
        .select('id, load_id, start_odometer, end_odometer, miles, entry_date, source, notes, created_at')
        .eq('load_id', load.id).order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      // '*' so this works before and after miles_source exists.
      supabase.from('loads').select('*').eq('id', load.id).maybeSingle(),
      supabase.from('documents').select('ai_extracted_data').eq('load_id', load.id).eq('doc_type', 'rate_confirmation').limit(5),
    ]);
    if (error) { console.error('mileage load', error); return setError('Could not load miles, please try again.'); }
    setEntries(data || []);
    setRateConMiles((rc || []).map((d) => extractedMiles(d.ai_extracted_data)).find((m) => m != null) ?? null);
    if (l) { setMigrated(hasMilesSourceColumn(l)); onLoadChange?.(pick(l)); setManual(l.total_miles ?? ''); }
  }

  useEffect(() => { if (supabase && load?.id) refresh(); }, [load?.id]);

  async function add(r) {
    const res = await supabase.from('mileage_entries').insert({ ...r, user_id: userId, load_id: load.id });
    if (!res.error) { setShowForm(false); refresh(); }
    return res;
  }

  async function remove(e) {
    const { error } = await supabase.from('mileage_entries').delete().eq('id', e.id);
    if (error) { console.error('mileage delete', error); return setError('Could not delete, please try again.'); }
    refresh();
  }

  async function saveManual(ev) {
    ev.preventDefault();
    const v = manual === '' ? null : Number(manual);
    if (v !== null && (!Number.isInteger(v) || v <= 0)) return setError('Miles must be a whole number greater than 0.');
    setSavingManual(true);
    setError(null); setNotice(null);
    try {
      const { data, error, migrated: m } = await writeLoadMiles(supabase, { loadId: load.id, miles: v, source: 'typed', select: 'total_miles, rate_per_mile' });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) { console.error('total_miles update', error); return setError('Could not save, please try again.'); }
      setMigrated(m);
      onLoadChange?.({ ...row, ...(m ? { miles_source: v == null ? null : 'typed' } : {}) });
      setManual(row.total_miles ?? '');
      // Before the migration the old trigger replaces typed miles with the mileage log total.
      if (v != null && row.total_miles !== v) setNotice(`Saved, but the mileage log total (${fmtMiles(row.total_miles)}) is used until the database update for typed miles is applied.`);
    } finally {
      setSavingManual(false);
    }
  }

  const list = entries || [];
  const loaded = sumBy(list, (e) => e.source === 'loaded');
  const deadhead = sumBy(list, (e) => e.source === 'deadhead');
  const total = sumBy(list);
  const rate = load.rate != null ? Number(load.rate) : null;
  const rpm = (m) => (rate != null && m > 0 ? rate / m : null);
  const note = milesSourceNote({ load, rateConMiles, loggedTotal: total });

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Miles</h2>
        <button onClick={() => setShowForm((v) => !v)} style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.9rem' }}>
          {showForm ? 'Cancel' : '+ Add miles'}
        </button>
      </div>
      {error && entries !== null && <p style={{ color: '#b91c1c' }}>{error}</p>}
      {entries === null ? (error ? <div style={{ marginTop: '0.5rem' }}><LoadError message={error} onRetry={refresh} /></div>
        : <p role="status" style={{ ...muted, fontSize: '0.85rem' }}>Loading…</p>) : (
        <>
          {/* Marc, Oct 18: "I like seeing both". Planned (typed > rate con > calculated) next to Actual (log sum). */}
          <div data-testid="miles-both" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', margin: '0.5rem 0' }}>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: '0.5rem 0.6rem', minWidth: 0 }}>
              <div style={{ ...muted, fontSize: '0.8rem' }}>Planned</div>
              <div data-testid="planned-miles" style={{ fontSize: '1.1rem', fontWeight: 600 }}>{load.total_miles > 0 ? fmtMiles(load.total_miles) : '—'}</div>
              {note && <div data-testid="miles-source" style={{ ...muted, fontSize: '0.75rem' }}>{note}</div>}
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: '0.5rem 0.6rem', minWidth: 0 }}>
              <div style={{ ...muted, fontSize: '0.8rem' }}>Actual</div>
              <div data-testid="actual-total" style={{ fontSize: '1.1rem', fontWeight: 600 }}>{list.length ? fmtMiles(total) : '—'}</div>
              <div style={{ ...muted, fontSize: '0.75rem' }}>{list.length ? 'from mileage log' : 'no log entries yet'}</div>
            </div>
          </div>
          <form onSubmit={saveManual} style={{ margin: '0.5rem 0' }} data-testid="planned-miles-form">
            <label htmlFor="load-total-miles" style={{ ...muted, fontSize: '0.85rem', display: 'block', margin: '0 0 0.25rem' }}>Planned miles (type to override)</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input id="load-total-miles" inputMode="numeric" pattern="[0-9]*" placeholder="Total miles" value={manual}
                onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} style={{ ...input, flex: '1 1 auto', minWidth: 0 }} />
              <button type="submit" disabled={savingManual}
                style={{ padding: '0 1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', whiteSpace: 'nowrap', minWidth: 72, flexShrink: 0, opacity: savingManual ? 0.6 : 1 }}>Save</button>
            </div>
            {notice && <p role="status" style={{ color: '#92400e', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>{notice}</p>}
            {load.total_miles > 0 && (
              <div style={{ ...row, marginTop: '0.4rem' }}><span style={muted}>RPM</span><strong>{load.rate_per_mile != null ? `${fmtMoney(load.rate_per_mile)}/mi` : fmtRpm(rpm(load.total_miles))}</strong></div>
            )}
          </form>
          {list.length > 0 ? (
            <div style={{ margin: '0.75rem 0 0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #f1f5f9' }} data-testid="actual-miles">
              <div style={{ ...muted, fontSize: '0.85rem', fontWeight: 600 }}>Actual (mileage log)</div>
              <div style={row}><span style={muted}>Loaded</span><span>{fmtMiles(loaded)}</span></div>
              <div style={row}><span style={muted}>Deadhead</span><span>{fmtMiles(deadhead)}</span></div>
              <div style={{ ...row, borderTop: '1px solid #f1f5f9' }}><span style={muted}>Loaded RPM</span><strong>{fmtRpm(rpm(loaded))}</strong></div>
              <div style={row}><span style={muted}>All-in RPM (loaded + deadhead)</span><strong>{fmtRpm(rpm(loaded + deadhead))}</strong></div>
              {rate == null && <p style={{ ...muted, fontSize: '0.8rem', margin: '0.25rem 0 0' }}>Add a rate to see RPM.</p>}
              {!migrated && <p style={{ ...muted, fontSize: '0.8rem', margin: '0.25rem 0 0' }}>Until the database update is applied, the mileage log total also replaces planned miles.</p>}
            </div>
          ) : (
            <p style={{ ...muted, fontSize: '0.8rem', margin: '0 0 0.4rem' }}>Logged miles add up under Actual{migrated ? ' and don’t change Planned' : ''}.</p>
          )}
          {showForm && <div style={{ margin: '0.75rem 0' }}><MileageForm onSubmit={add} /></div>}
          {list.map((e) => <EntryRow key={e.id} e={e} onDelete={remove} />)}
        </>
      )}
    </div>
  );
}
