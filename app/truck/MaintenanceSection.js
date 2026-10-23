'use client';
// Maintenance on the Truck tab: log a shop visit (checklist of services), history, edit / delete, odometer.
// Data: /api/truck/maintenance (RLS decides access). Hidden when the database update isn't applied yet.
import { useEffect, useRef, useState } from 'react';
import { SERVICE_TYPES, BASELINE_LABEL, MAX_RECEIPTS, typeLabel, fmtMiles, fmtMoney } from '../lib/maintenance';
import { laToday } from '../lib/sendCap';

const mdy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '—');
const loadLabel = (l) => `Load #${l.broker_load_number || l.id.slice(0, 8)}${l.broker_name ? ` · ${l.broker_name}` : ''}${l.status ? ` · ${l.status.replace('_', ' ')}` : ''}`;

function blank(odometer) {
  return { serviceDate: laToday(), odometer: odometer ?? '', vendor: '', totalCost: '', notes: '', addToExpenses: true, loadId: '', entrySource: 'logged', checked: {}, costs: {}, otherLabel: '' };
}
function fromVisit(v) {
  const checked = {}, costs = {};
  let otherLabel = '';
  for (const it of v.items) { checked[it.service_type] = true; if (it.cost != null) costs[it.service_type] = String(it.cost); if (it.service_type === 'other') otherLabel = it.service_label || ''; }
  return { serviceDate: v.service_date, odometer: v.odometer ?? '', vendor: v.vendor_name || '', totalCost: String(v.total_cost ?? ''), notes: v.notes || '',
    addToExpenses: v.add_to_expenses, loadId: v.load_id || '', entrySource: v.entry_source, checked, costs, otherLabel };
}
const toValues = (f) => ({
  serviceDate: f.serviceDate, odometer: f.odometer, vendor: f.vendor, totalCost: f.totalCost, notes: f.notes,
  addToExpenses: f.entrySource === 'baseline' ? false : f.addToExpenses, loadId: f.addToExpenses ? f.loadId : '', entrySource: f.entrySource,
  items: SERVICE_TYPES.filter(([k]) => f.checked[k]).map(([k]) => ({ serviceType: k, cost: f.costs[k] || '', label: k === 'other' ? f.otherLabel : undefined })),
});

export default function MaintenanceSection({ truck, api, supabase, user, s }) {
  const [m, setM] = useState(null);
  const [form, setForm] = useState(null); // { mode: 'add' | 'edit', id?, f }
  const [files, setFiles] = useState([]);
  const [odo, setOdo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  async function refresh() {
    const j = await api(`/api/truck/maintenance?truckId=${truck.id}`);
    setM(j.error && j.available !== false ? { available: true, error: j.error, visits: [], loads: [] } : j);
  }
  useEffect(() => { setForm(null); setM(null); refresh(); }, [truck.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m || m.available === false) return null; // not set up yet (or still loading): no section
  const set = (k) => (e) => { const val = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e; setForm((o) => ({ ...o, f: { ...o.f, [k]: val } })); };
  const f = form?.f;

  async function uploadReceipts(recordId) {
    let failed = 0;
    for (const file of files.slice(0, MAX_RECEIPTS)) {
      const path = `${user.id}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
      const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (up.error) { failed++; continue; }
      const ins = await supabase.from('documents').insert({ user_id: user.id, doc_type: 'maintenance_receipt', file_path: path, original_filename: file.name, truck_id: truck.id, service_record_id: recordId });
      if (ins.error) { failed++; await supabase.storage.from('documents').remove([path]); }
    }
    return failed;
  }

  async function save(e) {
    e.preventDefault();
    if (!SERVICE_TYPES.some(([k]) => f.checked[k])) return setMsg({ type: 'error', text: 'Check at least one service.' });
    setBusy(true); setMsg(null);
    const body = form.mode === 'add' ? { action: 'create', truckId: truck.id, values: toValues(f) } : { action: 'update', id: form.id, values: toValues(f) };
    const j = await api('/api/truck/maintenance', { method: 'POST', body: JSON.stringify(body) });
    if (j.error) { setBusy(false); return setMsg({ type: 'error', text: j.error }); }
    const failed = files.length ? await uploadReceipts(j.id) : 0;
    setBusy(false); setForm(null); setFiles([]);
    setMsg(failed ? { type: 'error', text: `Saved, but ${failed} receipt${failed > 1 ? 's' : ''} didn’t upload.` } : { type: 'ok', text: 'Service saved.' });
    refresh();
  }
  async function remove(v) {
    if (!window.confirm(v.expense_id ? 'Delete this service visit? Its expense is removed too.' : 'Delete this service visit?')) return;
    setBusy(true);
    const j = await api('/api/truck/maintenance', { method: 'POST', body: JSON.stringify({ action: 'delete', id: v.id }) });
    setBusy(false);
    setMsg(j.error ? { type: 'error', text: j.error } : { type: 'ok', text: 'Visit deleted.' });
    refresh();
  }
  async function saveOdo(e) {
    e.preventDefault(); setBusy(true);
    const j = await api('/api/truck/maintenance', { method: 'POST', body: JSON.stringify({ action: 'set_odometer', truckId: truck.id, odometer: odo }) });
    setBusy(false);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    setOdo(null); refresh();
  }

  const baseline = f?.entrySource === 'baseline';
  return (
    <section style={s.card} aria-label="Maintenance" data-testid="maintenance-card">
      <h2 style={s.h2}>Maintenance</h2>
      {m.error && <p style={s.err}>{m.error}</p>}
      <div style={s.row} data-testid="odometer-row">
        <span style={s.k}>Odometer</span>
        {odo === null ? (
          <span style={{ textAlign: 'right' }}>
            <strong>{m.odometer != null ? fmtMiles(m.odometer) : '—'}</strong>
            {m.odometerUpdatedAt && <span style={{ ...s.muted, fontSize: 12, display: 'block' }} data-testid="odometer-updated">Updated {mdy(String(m.odometerUpdatedAt).slice(0, 10))}</span>}
            {m.canSetOdometer && <button type="button" style={{ ...s.small, marginTop: 4 }} onClick={() => setOdo(String(m.odometer ?? ''))}>Edit</button>}
          </span>
        ) : (
          <form onSubmit={saveOdo} style={{ display: 'flex', gap: 6 }}>
            <input aria-label="Odometer miles" inputMode="numeric" style={{ ...s.input, width: 130 }} value={odo} onChange={(e) => setOdo(e.target.value)} />
            <button style={s.small} disabled={busy}>Save</button>
            <button type="button" style={s.small} onClick={() => setOdo(null)}>Cancel</button>
          </form>
        )}
      </div>

      {msg && <p role="status" style={msg.type === 'error' ? s.err : s.muted}>{msg.text}</p>}

      {form ? (
        <form onSubmit={save} data-testid="service-form">
          {baseline && <p style={s.muted}>{BASELINE_LABEL}: the last time each service was done before you started logging. No expense is created.</p>}
          <fieldset style={{ border: 'none', padding: 0, margin: '8px 0 0' }}>
            <legend style={s.label}>What was done?</legend>
            {SERVICE_TYPES.map(([k, label]) => (
              <div key={k} style={{ borderTop: '1px solid var(--divider)', padding: '4px 0' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 16 }}>
                  <input type="checkbox" data-testid={`svc-${k}`} style={{ width: 22, height: 22 }} checked={!!f.checked[k]}
                    onChange={(e) => setForm((o) => ({ ...o, f: { ...o.f, checked: { ...o.f.checked, [k]: e.target.checked } } }))} />
                  {label}
                </label>
                {f.checked[k] && (
                  <div style={{ display: 'flex', gap: 8, paddingLeft: 32, paddingBottom: 6 }}>
                    {k === 'other' && <input aria-label="What was it?" placeholder="What was it?" style={s.input} value={f.otherLabel} onChange={set('otherLabel')} maxLength={80} />}
                    <input aria-label={`${label} cost`} placeholder="Cost (optional)" inputMode="decimal" style={{ ...s.input, maxWidth: 160 }} value={f.costs[k] || ''}
                      onChange={(e) => setForm((o) => ({ ...o, f: { ...o.f, costs: { ...o.f.costs, [k]: e.target.value } } }))} />
                  </div>
                )}
              </div>
            ))}
          </fieldset>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><label style={s.label} htmlFor="svc-date">Date</label><input id="svc-date" type="date" style={s.input} value={f.serviceDate} max={laToday()} onChange={set('serviceDate')} required /></div>
            <div><label style={s.label} htmlFor="svc-miles">Miles</label><input id="svc-miles" inputMode="numeric" style={s.input} value={f.odometer} onChange={set('odometer')} /></div>
          </div>
          <label style={s.label} htmlFor="svc-vendor">Shop / vendor</label>
          <input id="svc-vendor" style={s.input} value={f.vendor} onChange={set('vendor')} maxLength={120} />
          <label style={s.label} htmlFor="svc-cost">Total cost</label>
          <input id="svc-cost" inputMode="decimal" placeholder="Leave blank to add up the item costs" style={s.input} value={f.totalCost} onChange={set('totalCost')} />
          <label style={s.label} htmlFor="svc-notes">Notes</label>
          <input id="svc-notes" style={s.input} value={f.notes} onChange={set('notes')} maxLength={1000} />
          {!baseline && (<>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 8 }}>
              <input type="checkbox" data-testid="svc-add-expense" style={{ width: 22, height: 22 }} checked={f.addToExpenses} onChange={set('addToExpenses')} />
              Add to expenses
            </label>
            <label style={s.label} htmlFor="svc-load">Add to a load</label>
            <select id="svc-load" data-testid="svc-load" style={s.input} value={f.addToExpenses ? f.loadId : ''} disabled={!f.addToExpenses} onChange={set('loadId')}>
              <option value="">None</option>
              {m.loads.map((l) => <option key={l.id} value={l.id}>{loadLabel(l)}</option>)}
            </select>
            <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" capture="environment" style={{ display: 'none' }} data-testid="svc-receipt-file"
              onChange={(e) => { setFiles((o) => [...o, ...Array.from(e.target.files || [])].slice(0, MAX_RECEIPTS)); e.target.value = ''; }} />
            <button type="button" style={s.btn2} onClick={() => fileRef.current?.click()}>📷 Add receipt{files.length ? ` (${files.length})` : ''}</button>
            <p style={{ ...s.muted, fontSize: 12, margin: '4px 0 0' }}>Receipts are saved to Documents. Up to {MAX_RECEIPTS}.</p>
          </>)}
          <button style={s.btn} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" style={s.btn2} onClick={() => { setForm(null); setFiles([]); }}>Cancel</button>
        </form>
      ) : m.canLog && (<>
        <button type="button" data-testid="log-service" style={s.btn} onClick={() => { setMsg(null); setForm({ mode: 'add', f: blank(m.odometer) }); }}>Log service</button>
        {m.role === 'owner' && <button type="button" data-testid="add-baseline" style={{ ...s.btn2, minHeight: 44 }} onClick={() => { setMsg(null); setForm({ mode: 'add', f: { ...blank(m.odometer), entrySource: 'baseline', addToExpenses: false } }); }}>Enter a starting point</button>}
      </>)}

      <ul data-testid="service-history" style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
        {m.visits.length === 0 && <li style={s.muted}>No service logged yet.</li>}
        {m.visits.map((v) => (
          <li key={v.id} data-testid="service-row" style={{ borderTop: '1px solid var(--divider)', padding: '8px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{mdy(v.service_date)}{v.odometer != null && ` · ${fmtMiles(v.odometer)}`}</span>
              {Number(v.total_cost) > 0 && <strong>{fmtMoney(v.total_cost)}</strong>}
            </div>
            {v.baseline && <div style={{ fontSize: 13, color: 'var(--primary)', fontWeight: 600 }}>{BASELINE_LABEL}</div>}
            <div style={{ fontSize: 14 }}>{v.items.map((it) => `${typeLabel(it)}${it.cost != null ? ` (${fmtMoney(it.cost)})` : ''}`).join(' · ')}</div>
            <div style={{ ...s.muted, fontSize: 13 }}>
              {[v.vendor_name, v.expense_id ? 'In expenses' : null, v.receipts.length ? `${v.receipts.length} receipt${v.receipts.length > 1 ? 's' : ''}` : null, v.notes].filter(Boolean).join(' · ')}
            </div>
            {v.canChange && !form && (
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button type="button" style={s.small} onClick={() => { setMsg(null); setForm({ mode: 'edit', id: v.id, f: fromVisit(v) }); }}>Edit</button>
                <button type="button" style={{ ...s.small, borderColor: 'var(--danger-border)', color: 'var(--danger)' }} disabled={busy} onClick={() => remove(v)}>Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
