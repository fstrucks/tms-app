'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSetup } from './useSetup';
import { getSupabase } from '../../lib/supabase';
import { checkVaultUpload } from '../../lib/companyDocs';
import { CATEGORIES, OPERATION_QUESTIONS, WIZARD_STEPS, GUIDANCE } from '../../lib/setupCatalog.js';
import {
  buildChecklist, summarize, matchesFilter, filterCounts, modelFromPayload, binderLines, visibleToRole, expiryEntries, FILTERS,
} from '../../lib/setupProgress.js';
import { complianceEntries, comingUp, entriesInMonth } from '../../lib/complianceCalendar.js';

const s = {
  main: { padding: '1rem', paddingBottom: 'calc(1rem + var(--fab-space))', fontFamily: 'system-ui', maxWidth: 960, margin: '0 auto' },
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.9rem', background: 'var(--surface)', marginBottom: '0.75rem' },
  muted: { color: 'var(--text-muted)', fontSize: 14, margin: '0.25rem 0' },
  btn: { minHeight: 44, padding: '0 0.85rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 600, cursor: 'pointer' },
  primary: { minHeight: 44, padding: '0 0.9rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700, cursor: 'pointer' },
  err: { color: 'var(--danger)', margin: '0.4rem 0' },
  ok: { color: 'var(--success)', margin: '0.4rem 0' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border)', fontSize: 16 },
};
const LEVEL = { required: 'Required', recommended: 'Recommended', conditional: 'If it applies' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pill(row) {
  if (!row.applicable) return ['Not needed', 'var(--surface-2)', 'var(--text-muted)'];
  if (row.bucket === 'done') return ['Done', 'var(--success-bg)', 'var(--success)'];
  if (row.bucket === 'expiring') return [`Expires ${row.expiryOn || 'soon'}`, 'var(--warning-bg)', 'var(--warning)'];
  if (row.bucket === 'expired') return ['Expired', 'var(--danger-bg)', 'var(--danger)'];
  if (row.skipped) return ['Skipped', 'var(--warning-bg)', 'var(--warning)'];
  return ['Missing', 'var(--danger-bg)', 'var(--danger)'];
}
const rowId = (r) => `${r.itemKey}:${r.truckId || ''}:${r.trailerId || ''}:${r.driverId || ''}`;

export default function ChecklistPage() {
  const { data, loading, patch, call, setData } = useSetup();
  const [guide, setGuide] = useState(false);
  const [step, setStep] = useState(1);
  const [filter, setFilter] = useState('all');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [month, setMonth] = useState(null);
  const [truckPick, setTruckPick] = useState('');
  const fileRef = useRef(null);
  const pending = useRef(null);
  const started = useRef(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('guide') === '1') setGuide(true);
  }, []);

  const office = !!data?.office;
  const today = data?.today;
  const ctx = useMemo(() => (data?.profile && today ? modelFromPayload(data, today) : null), [data, today]);
  const rows = useMemo(() => (ctx ? buildChecklist(ctx).filter((r) => visibleToRole(r, data.role)) : []), [ctx, data?.role]);
  const progress = summarize(rows);
  const counts = filterCounts(rows);
  const entries = useMemo(() => {
    if (!ctx || !office) return [];
    const rules = complianceEntries({
      today: ctx.today, dot: ctx.dot, answers: ctx.answers,
      iftaRenewalOn: ctx.iftaRenewalOn, irpRenewalOn: ctx.irpRenewalOn, hvutFirstUseOn: ctx.hvutFirstUseOn,
      reminders: ctx.reminders,
    });
    return [...rules, ...expiryEntries(rows, ctx.today)].sort((a, b) => String(a.due).localeCompare(String(b.due)) || a.title.localeCompare(b.title));
  }, [ctx, rows, office]);
  const soon = today ? comingUp(entries, today, 6) : [];
  const viewMonth = month || (today ? { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) } : null);
  const nextUp = rows.find((r) => r.applicable && r.counts && r.level === 'required' && !r.done && !r.needs);

  useEffect(() => {
    if (!guide || !office || data?.setupNeeded || started.current) return;
    started.current = true;
    patch({ action: 'start' });
  }, [guide, office, data?.setupNeeded, patch]);

  async function act(body, ok) {
    setBusy(true); setMsg(null);
    const j = await patch(body);
    setBusy(false);
    setMsg(j.error ? { type: 'error', text: j.error } : ok ? { type: 'ok', text: ok } : null);
    return j;
  }
  useEffect(() => {
    if (!highlight || guide) return;
    document.getElementById(`item-${highlight}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight, guide, filter]);

  function chooseFile(row) { pending.current = row; fileRef.current?.click(); }
  async function onFile(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    const row = pending.current; pending.current = null;
    if (!file || !row) return;
    const contentType = (file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg')).toLowerCase();
    const bad = checkVaultUpload({ size: file.size, contentType });
    if (bad) return setMsg({ type: 'error', text: bad });
    setBusy(true); setMsg(null);
    const body = { itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, filename: file.name };
    const start = await call('/api/setup/upload', { method: 'POST', body: JSON.stringify({ ...body, action: 'start', size: file.size, contentType }) });
    if (start.error) { setBusy(false); return setMsg({ type: 'error', text: start.error }); }
    const up = await getSupabase()?.storage.from('documents').uploadToSignedUrl(start.path, start.token, file, { contentType });
    if (up?.error) { setBusy(false); return setMsg({ type: 'error', text: 'The upload didn’t finish. Check your connection and try again.' }); }
    const done = await call('/api/setup/upload', { method: 'POST', body: JSON.stringify({ ...body, action: 'finish', path: start.path }) });
    setBusy(false);
    if (done.error) return setMsg({ type: 'error', text: done.error });
    if (done.profile || done.setupNeeded || done.needsProfile) setData(done);
    setMsg({ type: 'ok', text: `Saved ${file.name}.` });
  }

  function openEntry(entry) {
    if (entry?.needs === 'date') { setGuide(true); setStep(2); return; }
    setHighlight(entry?.itemKey || null);
    setFilter('all');
  }
  const shown = rows.filter((r) => matchesFilter(r, filter));
  const trucks = data?.trucks || [];
  const activeTruck = trucks.find((t) => t.id === truckPick) || trucks[0] || null;

  return (
    <main style={s.main}>
      <style>{`
        .setup-layout { display: flex; flex-direction: column; gap: 0.75rem; }
        .setup-next { order: -1; }
        @media (min-width: 800px) {
          .setup-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; align-items: start; }
          .setup-next { order: 0; }
        }
        .setup-cal-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
        @media (max-width: 420px) {
          .setup-cal-head { flex-direction: column; align-items: flex-start; }
          .setup-cal-nav { margin-right: 148px; }
        }
        @media print { .no-print { display: none !important; } }
      `}</style>
      <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" onChange={onFile} style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} tabIndex={-1} aria-hidden="true" />
      <div className="no-print" style={s.row}>
        <h1 style={{ fontSize: '1.45rem', margin: '0.2rem 0', flex: '1 1 auto' }}>Setup checklist</h1>
        <Link href="/documents" style={{ color: 'var(--primary)', fontWeight: 600 }}>Documents</Link>
      </div>
      {loading ? <p style={s.muted}>Loading checklist…</p>
        : data?.signedOut ? <p>Please <Link href="/login?next=/documents/checklist">sign in</Link>.</p>
        : data?.needsProfile ? <NeedsCompany />
        : data?.setupNeeded ? <p role="status" style={s.card}>The setup checklist needs a database update that hasn’t been applied yet.</p>
        : data?.error && !data.profile ? <p role="alert" style={s.err}>{data.error}</p>
        : (
          <>
            <Progress progress={progress} />
            {msg && <p role="status" style={msg.type === 'error' ? s.err : s.ok}>{msg.text}</p>}
            {data.limited && office && <p style={s.muted}>Some truck and file details aren’t available for this sign-in. Ticks you save still count.</p>}
            {!office && <p style={s.card}>You can check equipment and read the binder list for your truck. The rest of the checklist is for the office.</p>}
            {guide && office ? (
              <Guide step={step} setStep={setStep} rows={rows} ctx={ctx} data={data} busy={busy} act={act} setGuide={setGuide} chooseFile={chooseFile} trucks={trucks} activeTruck={activeTruck} setTruckPick={setTruckPick} progress={progress} />
            ) : (
              <div className="setup-layout">
                <div>
                  <div className="no-print" style={{ ...s.row, marginBottom: 8 }}>
                    {FILTERS.map((f) => (
                      <button key={f.id} type="button" data-compact aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                        style={{ ...s.btn, minHeight: 36, background: filter === f.id ? 'var(--primary)' : 'var(--surface)', color: filter === f.id ? 'var(--on-primary)' : 'var(--text)' }}>
                        {f.label} {counts[f.id] || 0}
                      </button>
                    ))}
                  </div>
                  {CATEGORIES.map((cat) => {
                    const mine = shown.filter((r) => r.category === cat.key);
                    if (!mine.length && cat.key !== 'billing') return null;
                    return (
                      <section key={cat.key} style={s.card} aria-label={cat.name}>
                        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.4rem' }}>{cat.name}</h2>
                        {cat.key === 'billing' && <p style={s.muted}>Invoices and factoring stay with your load paperwork. Nothing else is tracked in this group yet.</p>}
                        {mine.map((r) => (
                          <ItemRow key={rowId(r)} row={r} office={office} busy={busy} highlight={highlight === r.itemKey} act={act} chooseFile={chooseFile} call={call} />
                        ))}
                      </section>
                    );
                  })}
                  {office && (
                    <div className="no-print" style={{ ...s.row, marginTop: 8 }}>
                      <Link href={`/documents/checklist/print${activeTruck ? `?truck=${activeTruck.id}` : ''}`} style={s.btn}>Print binder and equipment</Link>
                      <Link href="/documents/checklist/audit" style={s.btn}>Audit folder</Link>
                    </div>
                  )}
                </div>
                <aside className="setup-next" style={s.card}>
                  <h2 style={{ fontSize: '1rem', margin: '0 0 0.4rem' }}>Next up</h2>
                  {nextUp ? (
                    <>
                      <p style={{ margin: '0.2rem 0', fontWeight: 700 }}>{nextUp.title}</p>
                      <p style={s.muted}>{nextUp.unitLabel} {nextUp.detail}</p>
                      <div style={{ ...s.row, marginTop: 8 }}>
                        {office && nextUp.kinds.includes('upload') && nextUp.docType && <button type="button" style={s.primary} disabled={busy} onClick={() => chooseFile(nextUp)}>Upload</button>}
                        {canTick(nextUp, office) && <button type="button" style={s.primary} disabled={busy} onClick={() => act({ action: 'status', itemKey: nextUp.itemKey, truckId: nextUp.truckId, trailerId: nextUp.trailerId, driverId: nextUp.driverId, status: 'done' }, 'Saved.')}>{tickLabel(nextUp)}</button>}
                      </div>
                    </>
                  ) : <p style={s.muted}>Every required item that applies is done.</p>}
                  {office && <button type="button" style={{ ...s.btn, width: '100%', marginTop: 10 }} onClick={() => { setStep(1); setGuide(true); }}>Guide me through</button>}
                  {office && soon.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Coming up</h3>
                      {soon.slice(0, 4).map((e) => <Reminder key={`${e.ruleKey}:${e.period}`} entry={e} busy={busy} act={act} onJump={openEntry} />)}
                    </div>
                  )}
                </aside>
              </div>
            )}
            {office && !guide && viewMonth && <Calendar viewMonth={viewMonth} setMonth={setMonth} entries={entries} busy={busy} act={act} onJump={openEntry} />}
          </>
        )}
    </main>
  );
}

function canUndo(row, office) {
  if (!row.ticked || !row.done || row.needs) return false;
  if (row.docType && row.documentId) return false;
  return canTick(row, office);
}
function canTick(row, office) {
  if (row.driverAccess === 'equipment') return true;
  if (!office) return false;
  return row.kinds.includes('audit') || row.kinds.includes('binder') || row.kinds.includes('equipment');
}
function tickLabel(row) {
  if (row.kinds.includes('equipment')) return 'On the truck';
  if (row.kinds.includes('binder') && !row.kinds.includes('audit')) return 'In the cab';
  return 'Mark done';
}

function Progress({ progress }) {
  const pct = progress.percent || 0;
  return (
    <section style={s.card} aria-label="Setup progress">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>{progress.requiredDone} of {progress.requiredTotal} required</strong>
        <span style={s.muted}>{progress.recommendedDone} of {progress.recommendedTotal} recommended</span>
      </div>
      <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Required items done" style={{ height: 10, borderRadius: 999, background: 'var(--surface-2)', marginTop: 8, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)' }} />
      </div>
    </section>
  );
}

function ItemRow({ row, office, busy, highlight, act, chooseFile, call }) {
  const [text, bg, fg] = pill(row);
  const showTag = office && row.verified === false;
  async function view() {
    if (!row.documentId) return;
    const j = await call(`/api/setup?view=${encodeURIComponent(row.documentId)}`);
    if (j.url) window.open(j.url, '_blank', 'noopener');
  }
  return (
    <div id={`item-${row.itemKey}`} style={{ padding: '0.7rem 0', borderTop: '1px solid var(--divider)', outline: highlight ? '2px solid var(--primary)' : 'none', borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650 }}>{row.title}{row.unitLabel ? ` · ${row.unitLabel}` : ''}</div>
          <div style={s.muted}>{LEVEL[row.level] || row.level}{row.detail ? ` · ${row.detail}` : ''}</div>
          {row.markedBy && <div style={s.muted}>{row.markedBy}</div>}
        </div>
        <span style={{ background: bg, color: fg, borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{text}</span>
      </div>
      {showTag && <div style={{ ...s.muted, color: 'var(--warning)' }}>Not confirmed</div>}
      <details>
        <summary style={{ cursor: 'pointer', marginTop: 4 }}>What this is</summary>
        <p style={s.muted}>{row.description}</p>
        {row.citation && <p style={s.muted}>{row.citation}</p>}
        <p style={s.muted}>{GUIDANCE}</p>
      </details>
      <div style={{ ...s.row, marginTop: 6 }}>
        {office && row.kinds.includes('upload') && row.docType && row.applicable && <button type="button" style={s.btn} disabled={busy} onClick={() => chooseFile(row)}>Upload</button>}
        {row.documentId && office && <button type="button" style={s.btn} onClick={view}>View</button>}
        {row.applicable && !row.done && canTick(row, office) && !row.needs && (
          <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, status: 'done' }, 'Saved.')}>{tickLabel(row)}</button>
        )}
        {canUndo(row, office) && (
          <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, status: 'not_yet' }, 'Reopened.')}>Undo</button>
        )}
        {row.applicable && !row.done && (office || row.driverAccess === 'equipment') && !row.needs && (
          <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, status: 'skipped' })}>Skip for now</button>
        )}
        {office && row.level !== 'required' && row.applicable && (
          <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, status: 'not_needed' })}>Not needed</button>
        )}
        {office && !row.applicable && (
          <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, status: 'not_yet' })}>Turn back on</button>
        )}
        {office && row.applicable && needsExpiry(row) && (
          <label style={{ ...s.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            Expires
            <input type="date" defaultValue={row.expiryOn || ''} aria-label={`Expiry for ${row.title}`} onChange={(e) => act({ action: 'status', itemKey: row.itemKey, truckId: row.truckId, trailerId: row.trailerId, driverId: row.driverId, status: row.done ? 'done' : 'not_yet', expiryOn: e.target.value || null })} style={{ ...s.input, width: 'auto' }} />
          </label>
        )}
      </div>
    </div>
  );
}
const EXPIRY_INPUT = new Set(['date', 'yearly', 'policy', 'ifta_renewal', 'irp']);
function needsExpiry(row) {
  return EXPIRY_INPUT.has(row.expiry);
}

function Reminder({ entry, busy, act, onJump }) {
  return (
    <div style={{ padding: '0.45rem 0', borderTop: '1px solid var(--divider)' }}>
      <div style={{ fontSize: 14 }}><strong>{entry.due}</strong> {entry.title}</div>
      <div style={s.muted}>{entry.detail}</div>
      <div style={{ ...s.row, marginTop: 4 }}>
        {entry.needs === 'date' ? <button type="button" style={s.btn} onClick={() => onJump(entry)}>Enter date</button> : (
          <>
            <button type="button" data-compact style={s.btn} disabled={busy} onClick={() => act({ action: 'reminder', ruleKey: entry.ruleKey, period: entry.period, truckId: entry.truckId, status: 'completed' }, 'Marked complete.')}>Complete</button>
            <button type="button" data-compact style={s.btn} disabled={busy} onClick={() => act({ action: 'reminder', ruleKey: entry.ruleKey, period: entry.period, truckId: entry.truckId, status: 'dismissed' })}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}

function Calendar({ viewMonth, setMonth, entries, busy, act, onJump }) {
  const { y, m } = viewMonth;
  const shift = (n) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  };
  const inMonth = entriesInMonth(entries.filter((e) => e.needs !== 'date'), y, m);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(firstDow).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const datesToEnter = entries.filter((e) => e.needs === 'date' && !e.dismissed && !e.completed);
  return (
    <section style={{ ...s.card, marginTop: '0.75rem' }} aria-label="Compliance calendar">
      <div className="setup-cal-head">
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Compliance calendar</h2>
        <div className="setup-cal-nav" style={s.row}>
          <button type="button" style={s.btn} onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <strong>{MONTHS[m - 1]} {y}</strong>
          <button type="button" data-above-fab style={s.btn} onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
      </div>
      <p style={s.muted}>On-screen only. Dates show when someone opens the app.</p>
      {datesToEnter.length > 0 && (
        <div style={{ margin: '0.4rem 0' }}>
          {datesToEnter.map((e) => <p key={e.period} style={s.muted}>{e.title}. {e.detail}</p>)}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4, marginTop: 8 }}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} style={{ ...s.muted, textAlign: 'center' }}>{d}</div>)}
        {cells.map((day, i) => {
          const iso = day ? `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
          const hits = day ? inMonth.filter((e) => e.due === iso) : [];
          return (
            <div key={i} style={{ minHeight: 64, border: '1px solid var(--divider)', borderRadius: 8, padding: 4, background: day ? 'var(--surface)' : 'transparent' }}>
              {day && <div style={{ fontSize: 12, fontWeight: 700 }}>{day}</div>}
              {hits.map((e) => (
                <button key={e.period} type="button" onClick={() => onJump(e)} title={e.title}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: e.completed ? 'var(--success-bg)' : 'var(--warning-bg)', color: 'var(--text)', borderRadius: 4, fontSize: 10, padding: '2px 3px', marginTop: 2, cursor: 'pointer' }}>
                  {e.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 8 }}>
        {inMonth.filter((e) => !e.completed).map((e) => <Reminder key={`m-${e.ruleKey}:${e.period}`} entry={e} busy={busy} act={act} onJump={onJump} />)}
      </div>
    </section>
  );
}

function NeedsCompany() {
  return (
    <section style={s.card}>
      <h2 style={{ marginTop: 0 }}>Add your company first</h2>
      <p style={s.muted}>The checklist is saved on the company. Add the company name, then come back.</p>
      <Link href="/company" style={s.primary}>Open company profile</Link>
    </section>
  );
}

function Guide({ step, setStep, rows, ctx, data, busy, act, setGuide, chooseFile, trucks, activeTruck, setTruckPick, progress }) {
  const saveRef = useRef(null);
  const info = WIZARD_STEPS.find((w) => w.id === step);
  async function goNext() {
    if (step === 2) {
      const ok = await saveRef.current?.();
      if (!ok) return;
    }
    setStep(step + 1);
  }
  const stepRows = rows.filter((r) => r.wizardStep === step && (r.applicable || r.needs));
  return (
    <section style={s.card} aria-label="Guide me">
      <p style={s.muted}>Step {step} of {WIZARD_STEPS.length}</p>
      <h2 style={{ margin: '0.2rem 0 0.6rem' }}>{info?.title}</h2>
      {step === 1 && (
        <>
          <p>Let’s get your company set up. About 15 minutes. You can stop any time.</p>
        </>
      )}
      {step === 2 && <CompanyStep data={data} busy={busy} act={act} saveRef={saveRef} />}
      {step >= 3 && step <= 7 && (
        stepRows.length ? stepRows.map((r) => (
          <div key={rowId(r)} style={{ padding: '0.55rem 0', borderTop: '1px solid var(--divider)' }}>
            <strong>{r.title}</strong>{r.unitLabel ? ` · ${r.unitLabel}` : ''}
            <div style={s.muted}>{r.needs ? r.detail : r.done ? (r.markedBy || 'Done') : (r.detail || LEVEL[r.level])}</div>
            {!r.needs && (
              <div style={{ ...s.row, marginTop: 6 }}>
                {!r.done && r.kinds.includes('upload') && r.docType && <button type="button" style={s.btn} disabled={busy} onClick={() => chooseFile(r)}>Upload</button>}
                {!r.done && canTick(r, true) && <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: r.itemKey, truckId: r.truckId, trailerId: r.trailerId, driverId: r.driverId, status: 'done' }, 'Saved.')}>{tickLabel(r)}</button>}
                {canUndo(r, true) && <button type="button" style={s.btn} disabled={busy} onClick={() => act({ action: 'status', itemKey: r.itemKey, truckId: r.truckId, trailerId: r.trailerId, driverId: r.driverId, status: 'not_yet' }, 'Reopened.')}>Undo</button>}
              </div>
            )}
            {r.needs === 'driver' && <Link href="/truck">Add a driver on the Truck tab</Link>}
            {r.needs === 'truck' && <Link href="/truck">Add a truck on the Truck tab</Link>}
          </div>
        )) : <p style={s.muted}>Nothing open in this step.</p>
      )}
      {step === 8 && <BinderStep ctx={ctx} rows={rows} trucks={trucks} activeTruck={activeTruck} setTruckPick={setTruckPick} />}
      {step === 9 && (
        <>
          <p><strong>{progress.requiredDone} of {progress.requiredTotal} required items are done.</strong></p>
          <ul>
            {rows.filter((r) => r.applicable && r.counts && r.level === 'required' && !r.done).slice(0, 12).map((r) => <li key={rowId(r)}>{r.title}{r.unitLabel ? ` (${r.unitLabel})` : ''}</li>)}
          </ul>
          <Link href="/documents/checklist/audit" style={s.btn}>Open the audit folder</Link>
        </>
      )}
      <div className="no-print" style={{ ...s.row, marginTop: 12 }}>
        {step > 1 && <button type="button" style={s.btn} disabled={busy} onClick={() => setStep(step - 1)}>Back</button>}
        <button type="button" style={s.btn} onClick={() => setGuide(false)}>Finish later</button>
        {step < 9 && <button type="button" style={s.btn} onClick={() => setStep(step + 1)}>Skip for now</button>}
        {step < 9 && <button type="button" style={s.primary} disabled={busy} onClick={goNext}>{step === 1 ? 'Start' : 'Save & next'}</button>}
        {step === 9 && <button type="button" style={s.primary} onClick={() => setGuide(false)}>Done</button>}
      </div>
    </section>
  );
}

function CompanyStep({ data, busy, act, saveRef }) {
  const p = data.profile || {};
  const [form, setForm] = useState({
    legal_name: p.legal_name || '', owner_name: p.owner_name || '', mc_number: p.mc_number || '', dot_number: p.dot_number || '',
    address_line1: p.address_line1 || '', city: p.city || '', state: p.state || '', postal_code: p.postal_code || '',
  });
  const [answers, setAnswers] = useState({ ...(p.operation_answers || {}) });
  const [dates, setDates] = useState({ iftaRenewalOn: p.ifta_renewal_on || '', irpRenewalOn: p.irp_renewal_on || '', hvutFirstUseOn: p.hvut_first_use_on || '' });
  const [localErr, setLocalErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function save() {
    setLocalErr(null);
    if (!form.legal_name.trim()) { setLocalErr('Enter the legal company name.'); return false; }
    const sb = getSupabase();
    const token = (await sb?.auth.getSession())?.data?.session?.access_token;
    const res = await fetch('/api/company-profile', { method: 'PUT', headers: { Authorization: `Bearer ${token || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setLocalErr(j.error || 'Could not save the company.'); return false; }
    const saved = await act({ action: 'answers', answers, replaceAnswers: true, ...dates }, 'Company saved.');
    if (saved?.error) { setLocalErr(saved.error); return false; }
    return true;
  }
  useEffect(() => { if (saveRef) saveRef.current = save; });
  return (
    <div>
      {['legal_name', 'Legal company name', 'owner_name', 'Owner name', 'dot_number', 'USDOT number', 'mc_number', 'MC number', 'address_line1', 'Street', 'city', 'City', 'state', 'State', 'postal_code', 'ZIP'].reduce((acc, cur, i, arr) => {
        if (i % 2) return acc;
        acc.push([cur, arr[i + 1]]); return acc;
      }, []).map(([key, label]) => (
        <label key={key} style={{ display: 'block', marginTop: 8 }}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <input style={s.input} value={form[key] || ''} onChange={set(key)} maxLength={key === 'state' ? 2 : undefined} />
        </label>
      ))}
      <h3 style={{ fontSize: '1rem', margin: '1rem 0 0.3rem' }}>About your operation</h3>
      {OPERATION_QUESTIONS.map((q) => (
        <fieldset key={q.key} style={{ border: 'none', padding: 0, margin: '0.6rem 0' }}>
          <legend style={{ fontWeight: 600 }}>{q.label}</legend>
          <div style={s.row}>
            {[[true, 'Yes'], [false, 'No']].map(([v, label]) => (
              <button key={label} type="button" aria-pressed={answers[q.key] === v} style={{ ...s.btn, background: answers[q.key] === v ? 'var(--primary)' : 'var(--surface)', color: answers[q.key] === v ? 'var(--on-primary)' : 'var(--text)' }} onClick={() => setAnswers({ ...answers, [q.key]: v })}>{label}</button>
            ))}
            <button type="button" style={s.btn} onClick={() => { const next = { ...answers }; delete next[q.key]; setAnswers(next); }}>Not sure</button>
          </div>
        </fieldset>
      ))}
      <label style={{ display: 'block', marginTop: 8 }}>IFTA renewal date <input type="date" style={s.input} value={dates.iftaRenewalOn || ''} onChange={(e) => setDates({ ...dates, iftaRenewalOn: e.target.value })} /></label>
      <label style={{ display: 'block', marginTop: 8 }}>IRP renewal date <input type="date" style={s.input} value={dates.irpRenewalOn || ''} onChange={(e) => setDates({ ...dates, irpRenewalOn: e.target.value })} /></label>
      <label style={{ display: 'block', marginTop: 8 }}>First day a 55,000 lb vehicle was used <input type="date" style={s.input} value={dates.hvutFirstUseOn || ''} onChange={(e) => setDates({ ...dates, hvutFirstUseOn: e.target.value })} /></label>
      {localErr && <p role="alert" style={s.err}>{localErr}</p>}
      <button type="button" style={{ ...s.primary, marginTop: 10 }} disabled={busy} onClick={save}>Save company</button>
    </div>
  );
}

function BinderStep({ ctx, rows, trucks, activeTruck, setTruckPick }) {
  if (!trucks.length) return <p style={s.muted}>Add a truck on the Truck tab, then print its binder.</p>;
  const lines = activeTruck && ctx ? binderLines(activeTruck, ctx, rows) : [];
  return (
    <div>
      <label>Truck{' '}
        <select value={activeTruck?.id || ''} onChange={(e) => setTruckPick(e.target.value)} style={s.input}>
          {trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number || 'Truck'}</option>)}
        </select>
      </label>
      <ul>{lines.map((l) => <li key={`${l.displayKey}:${l.itemKey}:${l.trailerId || ''}`}>{l.done ? '✓' : '○'} {l.title}</li>)}</ul>
      {activeTruck && <Link href={`/documents/checklist/print?truck=${activeTruck.id}`} style={s.primary}>Print binder and equipment</Link>}
    </div>
  );
}
