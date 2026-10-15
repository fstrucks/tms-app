'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { VISUALLY_HIDDEN } from '../../components/UploadMenu';
import { FIELDS, parseCsv, detectMapping, buildRows, missingRequired, toInsertRows,
  mappingToNames, mappingFromNames, mappingFits, importedUrl } from '../../lib/eldCsv';

const st = {
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem', minWidth: 0 },
  muted: { color: '#6b7280', fontSize: '0.85rem' },
  error: { color: '#b91c1c' },
  ok: { color: '#15803d' },
  input: { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '0.6rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #6b7280', background: '#fff', color: '#111827', colorScheme: 'light' },
  label: { display: 'block', fontSize: '0.85rem', color: '#374151', marginBottom: '0.25rem' },
  pick: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 8, background: '#2563eb', color: '#fff', fontSize: '1rem', cursor: 'pointer', textAlign: 'center' },
  btn: { width: '100%', minHeight: 48, padding: '0.8rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff' },
  btn2: { minHeight: 44, padding: '0 0.9rem', fontSize: '0.95rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#111' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem' },
  row: (bad) => ({ padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9', color: bad ? '#b91c1c' : '#111827', fontSize: '0.9rem', wordBreak: 'break-word' }),
};

// supabase/userId may be null (signed-out demo): everything works except saving.
export default function EldImport({ supabase, userId, onImported }) {
  const router = useRouter();
  const fileId = useId();
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState(null); // { headers, rows }
  const [mapping, setMapping] = useState({});
  const [saved, setSaved] = useState([]); // [{ id, name, mapping }]
  const [sourceName, setSourceName] = useState('');
  const [existing, setExisting] = useState(new Set());
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!supabase || !userId) return;
    supabase.from('eld_import_mappings').select('id, name, mapping').order('name').then(({ data, error }) => {
      if (error) console.error('eld mappings', error); else setSaved(data || []);
    });
  }, [supabase, userId]);

  async function onFile(e) {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!f) return;
    setMsg(null); setShowAll(false);
    const parsed = parseCsv(await f.text());
    if (!parsed.headers.length || !parsed.rows.length) { setCsv(null); return setMsg({ err: true, text: 'That file has no data rows.' }); }
    setFileName(f.name);
    setCsv(parsed);
    const fit = saved.find((s) => mappingFits(s.mapping, parsed.headers));
    if (fit) { setMapping(mappingFromNames(fit.mapping, parsed.headers)); setSourceName(fit.name); }
    else setMapping(detectMapping(parsed.headers));
  }

  const built = useMemo(() => (csv ? buildRows(csv.rows, mapping) : []), [csv, mapping]);
  const missing = csv ? missingRequired(mapping) : [];

  // Mark rows already imported earlier (same hash in the DB).
  useEffect(() => {
    if (!supabase || !userId || !built.length) return setExisting(new Set());
    const hashes = built.map((b) => b.value?.import_hash).filter(Boolean);
    if (!hashes.length) return;
    let cancelled = false;
    supabase.from('mileage_entries').select('import_hash').in('import_hash', hashes).then(({ data, error }) => {
      if (cancelled) return;
      if (error) console.error('eld dup check', error);
      setExisting(new Set((data || []).map((d) => d.import_hash)));
    });
    return () => { cancelled = true; };
  }, [built, supabase, userId]);

  const rows = built.map((b) => (b.value && existing.has(b.value.import_hash) ? { ...b, errors: ['Already imported'], duplicate: true } : b));
  const good = rows.filter((b) => b.value && !b.errors.length);
  const bad = rows.filter((b) => b.errors.length && !b.duplicate);
  const dups = rows.filter((b) => b.duplicate);
  const totalMiles = good.reduce((t, b) => t + b.value.miles, 0);

  async function saveMapping() {
    const name = sourceName.trim();
    if (!name) return setMsg({ err: true, text: 'Name this ELD/source (e.g. HOS247) to save the mapping.' });
    const { data, error } = await supabase.from('eld_import_mappings')
      .upsert({ user_id: userId, name, mapping: mappingToNames(mapping, csv.headers), updated_at: new Date().toISOString() }, { onConflict: 'user_id,name' })
      .select('id, name, mapping').single();
    if (error) { console.error('eld mapping save', error); return setMsg({ err: true, text: 'Could not save the mapping.' }); }
    setSaved((s) => [...s.filter((x) => x.name !== name), data].sort((a, b) => a.name.localeCompare(b.name)));
    setMsg({ text: `Saved mapping "${name}".` });
  }

  async function doImport() {
    setBusy(true); setMsg(null);
    try {
      const payload = toInsertRows(good, { userId, sourceName: sourceName.trim() });
      const { data, error } = await supabase.from('mileage_entries')
        .upsert(payload, { onConflict: 'user_id,import_hash', ignoreDuplicates: true }).select('id');
      if (error) { console.error('eld import', error); return setMsg({ err: true, text: 'Import failed, nothing was saved. Please try again.' }); }
      if (sourceName.trim() && !saved.some((s) => s.name === sourceName.trim())) await saveMapping();
      const n = data?.length ?? payload.length;
      // skipped = rows the preview already flagged as in the DB + any the upsert ignored (race).
      const skipped = rows.filter((b) => b.duplicate && b.errors[0] === 'Already imported').length + (payload.length - n);
      onImported?.();
      router.replace(importedUrl(n, skipped));
    } finally { setBusy(false); }
  }

  const preview = showAll ? rows : rows.slice(0, 25);

  return (
    <div style={{ minWidth: 0 }}>
      <div style={st.card}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>1. Upload ELD CSV</h2>
        <p style={st.muted}>Export the miles-by-state (IFTA) report from any ELD as CSV.</p>
        <input id={fileId} type="file" accept=".csv,text/csv,text/plain,application/vnd.ms-excel" onChange={onFile} style={VISUALLY_HIDDEN} />
        <label htmlFor={fileId} style={st.pick}>{fileName ? 'Choose a different CSV' : 'Choose CSV file'}</label>
        {fileName && <p style={{ ...st.muted, marginBottom: 0 }}>{fileName} · {csv?.rows.length || 0} rows</p>}
      </div>

      {csv && (
        <div style={st.card}>
          <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>2. Confirm columns</h2>
          <label style={{ display: 'block', marginBottom: '0.6rem' }}><span style={st.label}>ELD / source name</span>
            <input list="eld-sources" value={sourceName} placeholder="e.g. HOS247" onChange={(e) => {
              const v = e.target.value; setSourceName(v);
              const m = saved.find((s) => s.name === v);
              if (m) setMapping(mappingFromNames(m.mapping, csv.headers));
            }} style={st.input} />
            <datalist id="eld-sources">{saved.map((s) => <option key={s.id} value={s.name} />)}</datalist>
          </label>
          <div style={st.grid}>
            {FIELDS.map((f) => (
              <label key={f.key} style={{ display: 'block', minWidth: 0 }}><span style={st.label}>{f.label}{f.required ? ' *' : ''}</span>
                <select data-field={f.key} value={mapping[f.key] ?? -1} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))} style={st.input}>
                  <option value={-1}>— none —</option>
                  {csv.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {missing.length > 0 && <p style={st.error}>Map: {missing.join(', ')}</p>}
          {supabase && userId && <button type="button" onClick={saveMapping} style={{ ...st.btn2, marginTop: '0.6rem' }}>Save mapping</button>}
        </div>
      )}

      {csv && !missing.length && (
        <div style={st.card}>
          <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>3. Preview</h2>
          <p style={{ margin: '0 0 0.5rem' }}><span style={st.ok}>{good.length} ready ({totalMiles.toLocaleString('en-US')} mi)</span>
            {bad.length > 0 && <span style={st.error}> · {bad.length} with errors</span>}
            {dups.length > 0 && <span style={st.muted}> · {dups.length} duplicate (skipped)</span>}</p>
          {preview.map((b) => (
            <div key={b.line} style={st.row(b.errors.length && !b.duplicate)} data-row-status={b.duplicate ? 'dup' : b.errors.length ? 'error' : 'ok'}>
              <strong>Row {b.line}</strong>{' '}
              {b.value ? `${b.value.entry_date} · ${b.value.truck_label || '—'} · ${b.value.jurisdiction} · ${b.value.miles.toLocaleString('en-US')} mi${b.value.fuel_gallons ? ` · ${b.value.fuel_gallons} gal` : ''}` : b.raw.join(', ')}
              {b.errors.length > 0 && <div style={{ fontSize: '0.8rem', color: b.duplicate ? '#6b7280' : '#b91c1c' }}>{b.errors.join('; ')}</div>}
            </div>
          ))}
          {rows.length > preview.length && <button type="button" onClick={() => setShowAll(true)} style={{ ...st.btn2, marginTop: '0.5rem' }}>Show all {rows.length} rows</button>}
          <div style={{ position: 'sticky', bottom: 'calc(var(--nav-h, 0px) + env(safe-area-inset-bottom))', background: '#fff', padding: '0.6rem 0 0.2rem' }}>
            <button type="button" disabled={busy || !good.length || !supabase || !userId} onClick={doImport}
              style={{ ...st.btn, opacity: busy || !good.length || !supabase || !userId ? 0.6 : 1 }}>
              {busy ? 'Importing…' : `Import ${good.length} row${good.length === 1 ? '' : 's'}`}</button>
            {bad.length > 0 && <p style={{ ...st.muted, margin: '0.4rem 0 0' }}>Rows with errors are skipped.</p>}
          </div>
        </div>
      )}
      {msg && <p style={msg.err ? st.error : st.ok} role="status">{msg.text}</p>}
    </div>
  );
}
