'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { fmtMoney } from '../lib/loads';
import { MileageForm, EntryRow, sumBy, fmtMiles, fmtRpm } from '../lib/mileage';

const card = { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' };
const row = { display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', fontSize: '0.9rem' };
const muted = { color: '#6b7280' };
const input = { width: '100%', boxSizing: 'border-box', padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' };

// Miles section for one load. onLoadChange receives { total_miles, rate_per_mile } after the DB recalculates.
export default function LoadMileage({ load, userId, onLoadChange }) {
  const supabase = getSupabase();
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [manual, setManual] = useState(load.total_miles ?? '');
  const [savingManual, setSavingManual] = useState(false);

  async function refresh() {
    const [{ data, error }, { data: l }] = await Promise.all([
      supabase.from('mileage_entries')
        .select('id, load_id, start_odometer, end_odometer, miles, entry_date, source, notes, created_at')
        .eq('load_id', load.id).order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('loads').select('total_miles, rate_per_mile').eq('id', load.id).maybeSingle(),
    ]);
    if (error) return setError('Could not load miles: ' + error.message);
    setEntries(data || []);
    if (l) { onLoadChange?.(l); setManual(l.total_miles ?? ''); }
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
    if (v !== null && (!Number.isInteger(v) || v <= 0)) return setError('Total miles must be a whole number greater than 0.');
    setSavingManual(true);
    setError(null);
    try {
      const { data, error } = await supabase.from('loads').update({ total_miles: v }).eq('id', load.id)
        .select('total_miles, rate_per_mile').single();
      if (error) { console.error('total_miles update', error); return setError('Could not save, please try again.'); }
      onLoadChange?.(data);
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

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Miles</h2>
        <button onClick={() => setShowForm((v) => !v)} style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.9rem' }}>
          {showForm ? 'Cancel' : '+ Add miles'}
        </button>
      </div>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
      {entries === null ? <p style={{ ...muted, fontSize: '0.85rem' }}>Loading…</p> : (
        <>
          {list.length > 0 ? (
            <div style={{ margin: '0.5rem 0' }}>
              <div style={row}><span style={muted}>Total</span><span>{fmtMiles(total)}</span></div>
              <div style={row}><span style={muted}>Loaded</span><span>{fmtMiles(loaded)}</span></div>
              <div style={row}><span style={muted}>Deadhead</span><span>{fmtMiles(deadhead)}</span></div>
              <div style={{ ...row, borderTop: '1px solid #f1f5f9' }}><span style={muted}>Loaded RPM</span><strong>{fmtRpm(rpm(loaded))}</strong></div>
              <div style={row}><span style={muted}>All-in RPM (loaded + deadhead)</span><strong>{fmtRpm(rpm(loaded + deadhead))}</strong></div>
              {rate == null && <p style={{ ...muted, fontSize: '0.8rem', margin: '0.25rem 0 0' }}>Add a rate to see RPM.</p>}
            </div>
          ) : (
            <form onSubmit={saveManual} style={{ margin: '0.5rem 0' }}>
              <p style={{ ...muted, fontSize: '0.85rem', margin: '0 0 0.4rem' }}>No mileage entries. Enter total miles manually, or add entries below.</p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input inputMode="numeric" pattern="[0-9]*" placeholder="Total miles" value={manual}
                  onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} style={input} />
                <button type="submit" disabled={savingManual}
                  style={{ padding: '0 1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', opacity: savingManual ? 0.6 : 1 }}>Save</button>
              </div>
              {load.total_miles > 0 && (
                <div style={{ ...row, marginTop: '0.4rem' }}><span style={muted}>RPM</span><strong>{load.rate_per_mile != null ? `${fmtMoney(load.rate_per_mile)}/mi` : fmtRpm(rpm(load.total_miles))}</strong></div>
              )}
            </form>
          )}
          {showForm && <div style={{ margin: '0.75rem 0' }}><MileageForm onSubmit={add} /></div>}
          {list.map((e) => <EntryRow key={e.id} e={e} onDelete={remove} />)}
        </>
      )}
    </div>
  );
}
