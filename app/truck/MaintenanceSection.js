'use client';
// Maintenance on the Truck tab: log a shop visit (checklist of services), history, edit / delete, odometer.
// Data: /api/truck/maintenance (RLS decides access). Hidden when the database update isn't applied yet.
import { useEffect, useRef, useState } from 'react';
import { SERVICE_TYPES, BASELINE_LABEL, MAX_RECEIPTS, RECEIPT_TYPES, receiptType, receiptPath, typeLabel, fmtMiles, fmtMoney, DRIVER_NO_ACCESS } from '../lib/maintenance';
import { laToday } from '../lib/sendCap';
import { orderBySchedule, STATUS_LABEL } from '../lib/pmSchedule';
import { invoiceToForm } from '../lib/vaultScan';

const mdy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '—');
const loadLabel = (l) => `Load #${l.broker_load_number || l.id.slice(0, 8)}${l.broker_name ? ` - ${l.broker_name}` : ''}${l.status ? ` - ${l.status.replace('_', ' ')}` : ''}`;

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

// Maintenance vault (PR 3): prefill = { key, inv } opens the Log service form filled in from a scanned invoice.
// Nothing is saved until the user presses Save; then onPrefillSaved(recordId) links the vault document.
export default function MaintenanceSection({ truck, api, supabase, user, s, onChanged, reloadKey = 0, prefill = null, onPrefillSaved, onPrefillCancel }) {
  const [m, setM] = useState(null);
  const [form, setForm] = useState(null); // { mode: 'add' | 'edit', id?, f }
  const [files, setFiles] = useState([]);
  const [odo, setOdo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const seq = useRef(0);

  // Only the newest response is applied (a slow earlier GET can't overwrite fresh history), and the URL is unique
  // so no cache layer can hand back the list from before a save or delete.
  async function refresh() {
    const n = ++seq.current;
    const j = await api(`/api/truck/maintenance?truckId=${truck.id}&_=${Date.now()}`);
    if (n !== seq.current) return;
    setM(j.error && j.available !== false ? { available: true, error: j.error, visits: [], loads: [] } : j);
  }
  async function changed() { await refresh(); onChanged?.(); }
  useEffect(() => { setForm(null); setM(null); refresh(); }, [truck.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) refresh(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (prefill && m && !m.error) { setMsg(null); setFiles([]); setForm({ mode: 'add', fromScan: true, f: invoiceToForm(prefill.inv, blank(m.odometer)) }); }
  }, [prefill?.key, !!m]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m || m.available === false) return null; // not set up yet (or still loading): no section
  const set = (k) => (e) => { const val = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e; setForm((o) => ({ ...o, f: { ...o.f, [k]: val } })); };
  const f = form?.f;

  // Files go to the uploader's own folder ({auth uid}/...); the documents row has user_id = auth uid and no load_id.
  async function uploadReceipts(recordId) {
    let failed = 0;
    for (const file of files.slice(0, MAX_RECEIPTS)) {
      const path = receiptPath(user.id, file.name);
      const up = await supabase.storage.from('documents').upload(path, file, { contentType: receiptType(file) });
      if (up.error) { failed++; console.error('[maintenance] receipt upload', up.error.message); continue; }
      const ins = await supabase.from('documents').insert({ user_id: user.id, doc_type: 'maintenance_receipt', file_path: path, original_filename: file.name, truck_id: truck.id, service_record_id: recordId });
      if (ins.error) { failed++; console.error('[maintenance] receipt row', ins.error.message); await supabase.storage.from('documents').remove([path]); }
    }
    return failed;
  }
  function pickFiles(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = ''; // same file can be picked again
    const okFiles = picked.filter((x) => receiptType(x));
    if (okFiles.length < picked.length) setMsg({ type: 'error', text: 'Receipts must be a photo (JPG, PNG, WEBP, HEIC) or a PDF.' });
    setFiles((o) => [...o, ...okFiles].slice(0, MAX_RECEIPTS));
  }

  function cancelForm() { const scan = form?.fromScan; setForm(null); setFiles([]); if (scan) onPrefillCancel?.(); }

  async function save(e) {
    e.preventDefault();
    if (!SERVICE_TYPES.some(([k]) => f.checked[k])) return setMsg({ type: 'error', text: 'Check at least one service.' });
    if (form.mode === 'edit' && files.length + (form.receiptCount || 0) > MAX_RECEIPTS) return setMsg({ type: 'error', text: `Up to ${MAX_RECEIPTS} receipts per visit.` });
    setBusy(true); setMsg(null);
    const body = form.mode === 'add' ? { action: 'create', truckId: truck.id, values: toValues(f) } : { action: 'update', id: form.id, values: toValues(f) };
    const j = await api('/api/truck/maintenance', { method: 'POST', body: JSON.stringify(body) });
    if (j.error) { setBusy(false); return setMsg({ type: 'error', text: files.length ? `${j.error} Receipts weren’t uploaded yet.` : j.error }); }
    const failed = files.length ? await uploadReceipts(j.id) : 0;
    const linkErr = form.fromScan && onPrefillSaved ? await onPrefillSaved(j.id, f) : null;
    setBusy(false); setForm(null); setFiles([]);
    setMsg(failed ? { type: 'error', text: `Saved, but ${failed} receipt${failed > 1 ? 's' : ''} didn’t upload. Edit the visit to add ${failed > 1 ? 'them' : 'it'} again.` } : linkErr ? { type: 'error', text: `Service saved, but ${linkErr}` } : { type: 'ok', text: 'Service saved.' });
    await changed();
  }
  async function remove(v) {
    if (!window.confirm(v.expense_id ? 'Delete this service visit? Its expense is removed too.' : 'Delete this service visit?')) return;
    setBusy(true);
    const j = await api('/api/truck/maintenance', { method: 'POST', body: JSON.stringify({ action: 'delete', id: v.id }) });
    setBusy(false);
    if (!j.error) { seq.current++; setM((o) => (o ? { ...o, visits: (o.visits || []).filter((x) => x.id !== v.id) } : o)); }
    setMsg(j.error ? { type: 'error', text: j.error } : { type: 'ok', text: 'Visit deleted.' });
    await changed();
  }
  async function saveOdo(e) {
    e.preventDefault();
    if (!String(odo ?? '').trim()) return setMsg({ type: 'error', text: 'Enter the miles, or press Cancel to keep the odometer as it is.' });
    setBusy(true);
    const j = await api('/api/truck/maintenance', { method: 'POST', body: JSON.stringify({ action: 'set_odometer', truckId: truck.id, odometer: odo }) });
    setBusy(false);
    if (j.error) return setMsg({ type: 'error', text: j.error });
    setOdo(null); await changed();
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
          {form.fromScan && <p data-testid="scan-prefill-note" style={{ ...s.muted, background: 'var(--warning-bg)', color: 'var(--text)', borderRadius: 8, padding: '8px 10px' }}>Filled in from the scanned document. Check every field. Nothing is saved until you press Save.</p>}
          {baseline && <p style={s.muted}>{BASELINE_LABEL}: the last time each service was done before you started logging. No expense is created.</p>}
          <fieldset style={{ border: 'none', padding: 0, margin: '8px 0 0' }}>
            <legend style={s.label}>What was done?</legend>
            {orderBySchedule(SERVICE_TYPES, m.schedule).map(({ key: k, label, status, isDue }) => (
              <div key={k} style={{ borderTop: '1px solid var(--divider)', padding: '4px 0' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 16 }}>
                  <input type="checkbox" data-testid={`svc-${k}`} style={{ width: 22, height: 22 }} checked={!!f.checked[k]}
                    onChange={(e) => setForm((o) => ({ ...o, f: { ...o.f, checked: { ...o.f.checked, [k]: e.target.checked } } }))} />
                  {label}
                  {isDue && <span data-testid={`svc-due-${k}`} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: status === 'overdue' ? 'var(--danger)' : 'var(--warning)', background: status === 'overdue' ? 'var(--danger-bg, transparent)' : 'var(--warning-bg)' }}>{STATUS_LABEL[status]}</span>}
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
            <div><label style={s.label} htmlFor="svc-miles">Miles</label><input id="svc-miles" inputMode="numeric" placeholder="Blank = not recorded" style={s.input} value={f.odometer} onChange={set('odometer')} /></div>
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
              {form.mode === 'edit' && f.loadId && !m.loads.some((l) => l.id === f.loadId) && <option value={f.loadId}>Current load (kept)</option>}
              {m.loads.map((l) => <option key={l.id} value={l.id}>{loadLabel(l)}</option>)}
            </select>
            <input ref={fileRef} type="file" multiple accept={`${RECEIPT_TYPES.join(',')},.heic,.heif`} style={{ display: 'none' }} data-testid="svc-receipt-file"
              onChange={pickFiles} />
            <button type="button" style={s.btn2} onClick={() => fileRef.current?.click()}>📷 Add receipt{files.length ? ` (${files.length})` : ''}</button>
            <p style={{ ...s.muted, fontSize: 12, margin: '4px 0 0' }}>Receipts are saved to Documents. Up to {MAX_RECEIPTS}.</p>
          </>)}
          <button style={s.btn} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" style={s.btn2} onClick={cancelForm}>Cancel</button>
        </form>
      ) : m.canLog && (<>
        <button type="button" data-testid="log-service" style={s.btn} onClick={() => { setMsg(null); setFiles([]); setForm({ mode: 'add', f: blank(m.odometer) }); }}>Log service</button>
        {m.role === 'owner' && <button type="button" data-testid="add-baseline" style={{ ...s.btn2, minHeight: 44 }} onClick={() => { setMsg(null); setForm({ mode: 'add', f: { ...blank(m.odometer), entrySource: 'baseline', addToExpenses: false } }); }}>Enter a starting point</button>}
      </>)}

      {m.driverNoAccess && !form && <p data-testid="maint-driver-note" style={s.muted}>{DRIVER_NO_ACCESS}</p>}
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
                <button type="button" style={s.small} onClick={() => { setMsg(null); setFiles([]); setForm({ mode: 'edit', id: v.id, receiptCount: v.receipts.length, f: fromVisit(v) }); }}>Edit</button>
                <button type="button" style={{ ...s.small, borderColor: 'var(--danger-border)', color: 'var(--danger)' }} disabled={busy} onClick={() => remove(v)}>Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
