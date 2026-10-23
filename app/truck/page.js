'use client';
// Truck tab (PR #69): Truck & Trailer (with scale-ticket weight history), Maintenance, Driver, and a link to Company.
// Data goes through /api/truck (see app/lib/truckServer.js). Drivers get a read-only view.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import SignInLink from '../components/SignInLink';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { fieldValuesFromRows, expiryBadge, weightChecks, AXLE_LIMITS_LB } from '../lib/truckFields';
import { laToday } from '../lib/sendCap';
import MaintenanceSection from './MaintenanceSection';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 680, margin: '0 auto', boxSizing: 'border-box' },
  card: { background: 'var(--surface)', border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  h2: { fontSize: 18, margin: '0 0 0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid var(--divider)', fontSize: 15 },
  k: { color: 'var(--text-muted)' },
  muted: { color: 'var(--text-muted)', fontSize: 14 },
  err: { color: 'var(--danger)', fontSize: 14 },
  btn: { display: 'block', width: '100%', minHeight: 48, borderRadius: 10, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontSize: 16, fontWeight: 600, marginTop: 12 },
  btn2: { display: 'block', width: '100%', minHeight: 48, borderRadius: 10, border: '1px solid var(--primary)', background: 'var(--surface)', color: 'var(--primary)', fontSize: 16, fontWeight: 600, marginTop: 12 },
  small: { minHeight: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 14 },
  label: { display: 'block', fontSize: 14, fontWeight: 600, margin: '10px 0 4px' },
  input: { width: '100%', minHeight: 44, fontSize: 16, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', boxSizing: 'border-box' },
};
const TONES = { green: ['var(--success-bg)', 'var(--success)'], yellow: ['var(--warning-bg)', 'var(--warning)'], orange: ['var(--warning-bg)', 'var(--warning)'], red: ['var(--danger-bg)', 'var(--danger)'], 'red-strong': ['var(--danger)', 'var(--surface)'], grey: ['var(--surface-2)', 'var(--text)'] };
const lb = (n) => (n == null || n === '' ? '—' : `${Number(n).toLocaleString('en-US')} lb`);
const mdy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '—');
const loadLabel = (l) => (l ? `Load #${l.broker_load_number || l.id.slice(0, 8)}${l.broker_name ? ` · ${l.broker_name}` : ''}` : '');

function Row({ label, children, testid }) { return <div style={s.row} data-testid={testid}><span style={s.k}>{label}</span><span style={{ textAlign: 'right', fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span></div>; }
function Badge({ date, what }) {
  const b = expiryBadge(date, laToday()); const [bg, fg] = TONES[b.tone];
  return <span data-testid={`badge-${what}`} style={{ padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', marginLeft: 6 }}>{b.label}</span>;
}
function Field({ id, label, value, onChange, type = 'text', ...rest }) {
  return (<><label htmlFor={id} style={s.label}>{label}</label><input id={id} type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={s.input} {...rest} /></>);
}
function Warnings({ list, testid = 'weight-warnings' }) {
  if (!list?.length) return null;
  return <ul data-testid={testid} style={{ margin: '6px 0 0', paddingLeft: '1.1rem', color: 'var(--danger)', fontSize: 14 }}>{list.map((w) => <li key={w.code} data-code={w.code}>{w.text}</li>)}</ul>;
}

function TicketForm({ init, loads, truck, trailer, onSave, onCancel, busy, saveLabel }) {
  const [v, setV] = useState(init);
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const load = loads.find((l) => l.id === v.loadId);
  const preview = weightChecks({ ticket: v, truckEmpty: truck?.empty_weight_lb, trailerEmpty: trailer?.empty_weight_lb, loadWeight: load?.weight });
  return (
    <form data-testid="ticket-form" onSubmit={(e) => { e.preventDefault(); onSave(v); }} style={{ borderTop: '1px solid var(--divider)', marginTop: 8, paddingTop: 4 }}>
      <Field id="tk-date" label="Ticket date" type="date" value={v.ticket_date} onChange={set('ticket_date')} required />
      <Field id="tk-gross" label="Gross weight (lb)" inputMode="numeric" value={v.gross_weight_lb} onChange={set('gross_weight_lb')} required />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <div><Field id="tk-steer" label="Steer" inputMode="numeric" value={v.steer_axle_lb} onChange={set('steer_axle_lb')} placeholder={`≤ ${AXLE_LIMITS_LB.steer_axle_lb / 1000}k`} /></div>
        <div><Field id="tk-drive" label="Drive" inputMode="numeric" value={v.drive_axle_lb} onChange={set('drive_axle_lb')} placeholder={`≤ ${AXLE_LIMITS_LB.drive_axle_lb / 1000}k`} /></div>
        <div><Field id="tk-trailer" label="Trailer" inputMode="numeric" value={v.trailer_axle_lb} onChange={set('trailer_axle_lb')} placeholder={`≤ ${AXLE_LIMITS_LB.trailer_axle_lb / 1000}k`} /></div>
      </div>
      <Field id="tk-scale" label="Scale (optional)" value={v.scale_name} onChange={set('scale_name')} />
      <label htmlFor="tk-load" style={s.label}>Load (optional, compares with the rate con weight)</label>
      <select id="tk-load" value={v.loadId || ''} onChange={(e) => set('loadId')(e.target.value)} style={s.input}>
        <option value="">No load</option>
        {loads.map((l) => <option key={l.id} value={l.id}>{loadLabel(l)}{l.weight ? ` · ${lb(l.weight)}` : ''}</option>)}
      </select>
      {preview.net != null && <p style={{ ...s.muted, margin: '8px 0 0' }}>Net cargo: <strong>{lb(preview.net)}</strong></p>}
      <Warnings list={preview.warnings} testid="ticket-form-warnings" />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onCancel} style={{ ...s.btn2, flex: 1 }}>Cancel</button>
        <button type="submit" disabled={busy} style={{ ...s.btn, flex: 2, ...(busy ? { background: 'var(--text-muted)' } : null) }}>{busy ? 'Saving…' : saveLabel}</button>
      </div>
    </form>
  );
}

export default function TruckPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null); // 'truck' | 'trailer' | 'driver'
  const [form, setForm] = useState({});
  const [ticket, setTicket] = useState(null); // { mode: 'add' | 'confirm', id?, init, documentId? }
  const fileRef = useRef(null);

  async function api(path, opts = {}) {
    const t = (await supabase.auth.getSession())?.data?.session?.access_token;
    let res;
    try { res = await fetch(path, { ...opts, cache: 'no-store', headers: { Authorization: `Bearer ${t || ''}`, 'Content-Type': 'application/json' } }); }
    catch { return { error: 'Couldn’t reach the server. Try again.' }; }
    const j = await res.json().catch(() => ({}));
    return res.ok ? j : { ...j, error: j.error || `Something went wrong (${res.status}).` };
  }
  async function load(truckId) {
    const j = await api(`/api/truck${truckId ? `?truckId=${truckId}` : ''}`);
    if (j.error) { setErr(j); return; }
    setErr(null); setD(j);
  }
  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && u) setTimeout(() => load(), 0);
      if (event === 'SIGNED_OUT') setD(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function post(path, body, okMsg) {
    setBusy(true); setMsg(null);
    const j = await api(path, { method: 'POST', body: JSON.stringify(body) });
    setBusy(false);
    if (j.error && !j.trucks) { setMsg({ type: 'error', text: j.error }); return null; }
    setD(j); if (okMsg) setMsg({ type: 'ok', text: okMsg });
    return j;
  }
  const truck = d?.truck, trailer = d?.trailer, driver = d?.driver, ro = d && !d.canEdit;
  const v = fieldValuesFromRows({ truck, trailer, driver });

  function startEdit(which) {
    setMsg(null); setEdit(which);
    if (which === 'truck') setForm({ truck_number: v.truck_number, truck_plate: v.truck_plate, truck_plate_state: v.truck_plate_state, vin: truck?.vin || '', truck_empty_weight_lb: truck?.empty_weight_lb ?? '' });
    if (which === 'trailer') setForm({ trailer_number: v.trailer_number, trailer_plate: v.trailer_plate, trailer_plate_state: v.trailer_plate_state, trailer_empty_weight_lb: trailer?.empty_weight_lb ?? '' });
    if (which === 'driver') setForm({ driver_name: v.driver_name, phone: driver?.phone || '', cdl_number: driver?.cdl_number || '', cdl_state: driver?.cdl_state || '', cdl_expiry: driver?.cdl_expiry || '', med_card_expiry: driver?.med_card_expiry || '' });
  }
  async function saveEdit(e) {
    e.preventDefault();
    const body = edit === 'truck' ? { action: 'save_truck', id: truck?.id, values: form }
      : edit === 'trailer' ? { action: 'save_trailer', id: trailer?.id, truckId: truck.id, values: form }
      : { action: 'save_driver', id: driver?.id, truckId: truck.id, values: form };
    if (await post('/api/truck', body, 'Saved.')) setEdit(null);
  }
  const f = (k) => (x) => setForm((o) => ({ ...o, [k]: x }));

  async function onFile(file) {
    if (!file || !truck) return;
    if (file.size > 10 * 1024 * 1024) return setMsg({ type: 'error', text: 'That file is larger than 10 MB.' });
    setBusy(true); setMsg({ type: 'info', text: 'Reading the scale ticket…' });
    const path = `${user.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (up.error) { setBusy(false); return setMsg({ type: 'error', text: 'Upload failed. Try again.' }); }
    const ins = await supabase.from('documents').insert({ user_id: user.id, doc_type: 'scale_ticket', file_path: path, original_filename: file.name, truck_id: truck.id }).select('id').single();
    if (ins.error) { await supabase.storage.from('documents').remove([path]); setBusy(false); return setMsg({ type: 'error', text: 'Saving the ticket failed. Try again.' }); }
    setBusy(false);
    const j = await post('/api/truck/scale-tickets', { action: 'scan', truckId: truck.id, documentId: ins.data.id });
    if (!j) return;
    if (j.readError) { setMsg({ type: 'error', text: j.readError }); setTicket({ mode: 'add', documentId: j.documentId, init: { ticket_date: j.read?.ticket_date || laToday(), gross_weight_lb: j.read?.gross_weight_lb ?? '', steer_axle_lb: j.read?.steer_axle_lb ?? '', drive_axle_lb: j.read?.drive_axle_lb ?? '', trailer_axle_lb: j.read?.trailer_axle_lb ?? '', scale_name: j.read?.scale_name || '', loadId: '' } }); return; }
    if (j.note) return setMsg({ type: 'ok', text: j.note });
    const t = j.tickets.find((x) => x.id === j.ticketId);
    if (t && !t.confirmed) { setMsg({ type: 'ok', text: `Read ${lb(t.gross_weight_lb)}${j.dateMissing ? ' (no date found, check it)' : ''}. Check it and tap Confirm.` }); openConfirm(t); }
  }
  function openConfirm(t) {
    setTicket({ mode: 'confirm', id: t.id, init: { ticket_date: t.ticket_date, gross_weight_lb: t.gross_weight_lb ?? '', steer_axle_lb: t.steer_axle_lb ?? '', drive_axle_lb: t.drive_axle_lb ?? '', trailer_axle_lb: t.trailer_axle_lb ?? '', scale_name: t.scale_name || '', loadId: t.load_id || '' } });
  }
  async function saveTicket(vals) {
    const { loadId, ...values } = vals;
    const body = ticket.mode === 'add' ? { action: 'add', truckId: truck.id, values, loadId: loadId || null, documentId: ticket.documentId || null } : { action: 'confirm', truckId: truck.id, id: ticket.id, values, loadId: loadId || null };
    if (await post('/api/truck/scale-tickets', body, ticket.mode === 'add' ? 'Ticket added.' : 'Ticket confirmed.')) setTicket(null);
  }

  const editForm = (fields) => (
    <form onSubmit={saveEdit} data-testid={`edit-${edit}`}>
      {fields}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => setEdit(null)} style={{ ...s.btn2, flex: 1 }}>Cancel</button>
        <button type="submit" disabled={busy} style={{ ...s.btn, flex: 2, ...(busy ? { background: 'var(--text-muted)' } : null) }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );

  return (
    <main style={s.main} data-testid="truck-page">
      <h1 style={{ fontSize: 24, margin: '0.25rem 0 0.75rem' }}>Truck</h1>
      {supabaseConfigError ? <p style={s.err}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={{ color: 'var(--primary)' }}>sign in</SignInLink> to see your truck.</p>
        : err?.setupNeeded ? <p data-testid="truck-setup" style={{ ...s.card, color: 'var(--warning)', background: 'var(--warning-bg)' }}>The Truck tab is waiting on a database update. It will work once that’s applied.</p>
        : err ? <p style={s.err}>{err.error} <button type="button" onClick={() => load()} style={s.small}>Retry</button></p>
        : !d ? <p style={s.muted}>Loading…</p>
        : (<>
          {ro && <p data-testid="read-only-note" style={{ background: 'var(--info-bg)', color: 'var(--primary)', borderRadius: 8, padding: '8px 10px', fontSize: 14, margin: '0 0 0.75rem' }}>View only. Ask the owner or dispatcher to change truck, trailer or driver details.</p>}
          {msg && <p role={msg.type === 'error' ? 'alert' : 'status'} data-testid="truck-msg" style={{ ...(msg.type === 'error' ? s.err : { color: msg.type === 'ok' ? 'var(--success)' : 'var(--primary)', fontSize: 14 }), margin: '0 0 0.75rem' }}>{msg.text}</p>}
          {d.trucks.length > 1 && (
            <label style={{ display: 'block', fontSize: 14, color: 'var(--text)', marginBottom: 12 }}>Truck{' '}
              <select data-testid="truck-picker" value={truck?.id || ''} onChange={(e) => load(e.target.value)} style={{ minHeight: 44, fontSize: 16 }}>
                {d.trucks.map((t) => <option key={t.id} value={t.id}>#{t.unit_number}</option>)}
              </select>
            </label>
          )}

          <section style={s.card} aria-label="Truck & Trailer" data-testid="truck-card">
            <h2 style={s.h2}>Truck &amp; Trailer</h2>
            {!truck && edit !== 'truck' ? (<>
              <p style={s.muted}>No truck yet.</p>
              {!ro && <button type="button" style={s.btn} onClick={() => startEdit('truck')}>Add your truck</button>}
            </>) : edit === 'truck' ? editForm(<>
              <Field id="truck_number" label="Truck number" value={form.truck_number} onChange={f('truck_number')} required />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                <div><Field id="truck_plate" label="Truck plate" value={form.truck_plate} onChange={f('truck_plate')} /></div>
                <div><Field id="truck_plate_state" label="State" value={form.truck_plate_state} onChange={f('truck_plate_state')} maxLength={2} /></div>
              </div>
              <Field id="vin" label="VIN" value={form.vin} onChange={f('vin')} maxLength={17} />
              <Field id="truck_empty_weight_lb" label="Empty weight, truck (lb)" inputMode="numeric" value={form.truck_empty_weight_lb} onChange={f('truck_empty_weight_lb')} />
            </>) : edit === 'trailer' ? editForm(<>
              <Field id="trailer_number" label="Trailer number" value={form.trailer_number} onChange={f('trailer_number')} required />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                <div><Field id="trailer_plate" label="Trailer plate" value={form.trailer_plate} onChange={f('trailer_plate')} /></div>
                <div><Field id="trailer_plate_state" label="State" value={form.trailer_plate_state} onChange={f('trailer_plate_state')} maxLength={2} /></div>
              </div>
              <Field id="trailer_empty_weight_lb" label="Empty weight, trailer (lb)" inputMode="numeric" value={form.trailer_empty_weight_lb} onChange={f('trailer_empty_weight_lb')} />
            </>) : (<>
              <Row label="Truck number" testid="v-truck_number">#{v.truck_number}</Row>
              <Row label="Truck plate">{v.truck_plate || '—'}{v.truck_plate_state ? ` · ${v.truck_plate_state}` : ''}</Row>
              <Row label="VIN">{truck.vin || '—'}</Row>
              <Row label="Empty weight (truck)">{lb(truck.empty_weight_lb)}</Row>
              {trailer ? (<>
                <Row label="Trailer number" testid="v-trailer_number">{v.trailer_number}</Row>
                <Row label="Trailer plate">{v.trailer_plate || '—'}{v.trailer_plate_state ? ` · ${v.trailer_plate_state}` : ''}</Row>
                <Row label="Empty weight (trailer)">{lb(trailer.empty_weight_lb)}</Row>
              </>) : <Row label="Trailer">None linked</Row>}
              {!ro && <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={{ ...s.btn2, flex: 1 }} onClick={() => startEdit('truck')}>Edit truck</button>
                <button type="button" style={{ ...s.btn2, flex: 1 }} onClick={() => startEdit('trailer')}>{trailer ? 'Edit trailer' : 'Add trailer'}</button>
              </div>}
            </>)}
          </section>

          {truck && (
            <section style={s.card} aria-label="Scale weights" data-testid="scale-card">
              <h2 style={s.h2}>Scale weights</h2>
              {d.latest ? (
                <div data-testid="latest-weight" style={{ background: 'var(--info-bg)', borderRadius: 10, padding: '0.75rem', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--primary)' }}>Latest weight · {mdy(d.latest.ticket_date)}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)' }}>{lb(d.latest.gross_weight_lb)}</div>
                  {d.latest.net != null && <div style={{ fontSize: 14, color: 'var(--primary)' }}>Net cargo {lb(d.latest.net)}</div>}
                  {d.latest.scale_name && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{d.latest.scale_name}</div>}
                </div>
              ) : <p style={s.muted}>No scale tickets yet.</p>}
              <ul data-testid="weight-history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {d.tickets.map((t) => (
                  <li key={t.id} data-testid="ticket-row" style={{ borderTop: '1px solid var(--divider)', padding: '8px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>{mdy(t.ticket_date)}{!t.confirmed && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: 12, fontWeight: 600 }}>Check &amp; confirm</span>}</span>
                      <strong style={{ whiteSpace: 'nowrap' }}>{lb(t.gross_weight_lb)}</strong>
                    </div>
                    <div style={{ ...s.muted, fontSize: 13 }}>
                      {[t.net != null ? `Net cargo ${lb(t.net)}` : 'Net cargo needs both empty weights', t.load ? `${loadLabel(t.load)}${t.load.weight ? ` (rate con ${lb(t.load.weight)})` : ''}` : null, t.scale_name].filter(Boolean).join(' · ')}
                    </div>
                    {!(ticket?.mode === 'confirm' && ticket.id === t.id) && <Warnings list={t.warnings} />}
                    {!ro && ticket?.mode === 'confirm' && ticket.id === t.id
                      ? <TicketForm init={ticket.init} loads={d.loads} truck={truck} trailer={trailer} busy={busy} saveLabel="Confirm" onSave={saveTicket} onCancel={() => setTicket(null)} />
                      : !ro && <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        {!t.confirmed && <button type="button" style={{ ...s.small, borderColor: 'var(--success)', color: 'var(--success)' }} onClick={() => openConfirm(t)}>Check &amp; confirm</button>}
                        <button type="button" style={{ ...s.small, borderColor: 'var(--danger-border)', color: 'var(--danger)' }} disabled={busy} onClick={() => { if (window.confirm('Remove this scale ticket from the history?')) post('/api/truck/scale-tickets', { action: 'delete', truckId: truck.id, id: t.id }, 'Ticket removed.'); }}>Remove</button>
                      </div>}
                  </li>
                ))}
              </ul>
              {!ro && (ticket?.mode === 'add'
                ? <TicketForm init={ticket.init} loads={d.loads} truck={truck} trailer={trailer} busy={busy} saveLabel="Add ticket" onSave={saveTicket} onCancel={() => setTicket(null)} />
                : <>
                  <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" data-testid="scale-file" style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
                  <button type="button" data-testid="scan-scale-ticket" disabled={busy} style={{ ...s.btn, ...(busy ? { background: 'var(--text-muted)' } : null) }} onClick={() => fileRef.current?.click()}>{busy ? 'Working…' : '📷 Scan scale ticket'}</button>
                  <button type="button" data-testid="add-ticket" style={{ ...s.btn2, minHeight: 44 }} onClick={() => setTicket({ mode: 'add', init: { ticket_date: laToday(), gross_weight_lb: '', steer_axle_lb: '', drive_axle_lb: '', trailer_axle_lb: '', scale_name: '', loadId: '' } })}>Enter a ticket by hand</button>
                  <p style={{ ...s.muted, fontSize: 12, margin: '6px 0 0' }}>Scanning reads the weight and date. You check it before it counts.</p>
                </>)}
            </section>
          )}

          {truck && <MaintenanceSection truck={truck} api={api} supabase={supabase} user={user} s={s} />}

          {truck && (
            <section style={s.card} aria-label="Driver" data-testid="driver-card">
              <h2 style={s.h2}>Driver</h2>
              {edit === 'driver' ? editForm(<>
                <Field id="driver_name" label="Name" value={form.driver_name} onChange={f('driver_name')} required />
                <Field id="phone" label="Phone" type="tel" value={form.phone} onChange={f('phone')} />
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                  <div><Field id="cdl_number" label="CDL number" value={form.cdl_number} onChange={f('cdl_number')} /></div>
                  <div><Field id="cdl_state" label="State" value={form.cdl_state} onChange={f('cdl_state')} maxLength={2} /></div>
                </div>
                <Field id="cdl_expiry" label="CDL expires" type="date" value={form.cdl_expiry} onChange={f('cdl_expiry')} />
                <Field id="med_card_expiry" label="Med card expires" type="date" value={form.med_card_expiry} onChange={f('med_card_expiry')} />
              </>) : driver ? (<>
                <Row label="Name" testid="v-driver_name">{v.driver_name}</Row>
                <Row label="Phone">{driver.phone ? <a href={`tel:${driver.phone}`} style={{ color: 'var(--primary)' }}>{driver.phone}</a> : '—'}</Row>
                <Row label="CDL">{driver.cdl_number || '—'}{driver.cdl_state ? ` · ${driver.cdl_state}` : ''}</Row>
                <Row label="CDL expires"><span>{mdy(driver.cdl_expiry)}<Badge date={driver.cdl_expiry} what="cdl" /></span></Row>
                <Row label="Med card expires"><span>{mdy(driver.med_card_expiry)}<Badge date={driver.med_card_expiry} what="med" /></span></Row>
                <Row label="Drives">Truck #{v.truck_number}</Row>
                {!ro && <button type="button" style={s.btn2} onClick={() => startEdit('driver')}>Edit driver</button>}
              </>) : (<>
                <p style={s.muted}>No driver on this truck.</p>
                {!ro && <button type="button" style={s.btn2} onClick={() => startEdit('driver')}>Add driver</button>}
              </>)}
            </section>
          )}

          <section style={s.card} aria-label="Company">
            <h2 style={s.h2}>Company</h2>
            <Link href="/company" data-testid="company-link" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, fontSize: 16, color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>Company profile, insurance &amp; documents <span aria-hidden>›</span></Link>
          </section>
        </>)}
    </main>
  );
}
