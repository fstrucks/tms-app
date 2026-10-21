'use client';

// Home cards for the setup checklist: progress, roadside ready, and a one-PDF driver file.
// TODO: Ready to factor card. Depends on invoicing work in progress elsewhere. Do not ship until invoices exist.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSetup } from '../documents/checklist/useSetup';
import { getSupabase } from '../lib/supabase';
import { buildChecklist, summarize, modelFromPayload, roadsideForTruck, driverFileRows, expiryEntries } from '../lib/setupProgress';
import { complianceEntries, homeComingUp } from '../lib/complianceCalendar';

const card = { border: '1px solid var(--divider)', borderRadius: 12, padding: '0.9rem', background: 'var(--surface)', marginTop: '0.75rem' };
const muted = { color: 'var(--text-muted)', fontSize: 14, margin: '0.25rem 0' };
const btn = { minHeight: 44, padding: '0 0.85rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 600, cursor: 'pointer' };
const primary = { minHeight: 44, padding: '0 0.9rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' };

export default function HomeSetup() {
  const { data, loading, patch } = useSetup();
  const router = useRouter();
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data?.entry === 'guide') router.replace('/documents/checklist?guide=1');
  }, [data?.entry, router]);

  const office = !!data?.office;
  const today = data?.today;
  const ctx = useMemo(() => (data?.profile && today ? modelFromPayload(data, today) : null), [data, today]);
  const rows = useMemo(() => (ctx ? buildChecklist(ctx) : []), [ctx]);
  const progress = summarize(rows);
  const entries = useMemo(() => {
    if (!ctx || !office) return [];
    return [...complianceEntries({
      today: ctx.today, dot: ctx.dot, answers: ctx.answers,
      iftaRenewalOn: ctx.iftaRenewalOn, irpRenewalOn: ctx.irpRenewalOn, hvutFirstUseOn: ctx.hvutFirstUseOn,
      reminders: ctx.reminders,
    }), ...expiryEntries(rows, ctx.today)];
  }, [ctx, rows, office]);
  const soon = today ? homeComingUp(entries, today, 5) : [];

  if (loading || !data?.profile || data.setupNeeded || data.needsProfile || data.entry === 'guide') return null;

  const dismissed = !!data.profile.setup_dismissed_at;
  const complete = progress.requiredTotal > 0 && progress.requiredDone >= progress.requiredTotal;
  const showBanner = office && (!dismissed || !complete);
  const trucks = data.trucks || [];
  const drivers = office ? (data.drivers || []) : [];

  async function dismiss() {
    setBusy(true); setMsg(null);
    const j = await patch({ action: 'dismiss' });
    setBusy(false);
    if (j.error) setMsg(j.error);
  }

  async function download(driver) {
    setBusy(true); setMsg(null);
    const token = (await getSupabase()?.auth.getSession())?.data?.session?.access_token;
    let res;
    try {
      res = await fetch(`/api/setup/driver-file?driverId=${encodeURIComponent(driver.id)}`, { headers: { Authorization: `Bearer ${token || ''}` } });
    } catch {
      setBusy(false); setMsg('Could not build the driver file. Check your connection and try again.'); return;
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setBusy(false); setMsg(j.error || 'Could not build the driver file.'); return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = String(driver.name || 'driver').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'driver';
    a.download = `driver-file-${safe}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setBusy(false);
  }

  return (
    <section aria-label="Company setup">
      {data.entry === 'prompt' && office && (
        <div style={card}>
          <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.3rem' }}>Set up your company checklist</h2>
          <p style={muted}>Authority, insurance, driver files, and the papers that belong in the truck. About 15 minutes. You can stop any time.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Link href="/documents/checklist?guide=1" style={primary}>Guide me</Link>
            <button type="button" style={btn} disabled={busy} onClick={() => patch({ action: 'prompt' })}>Not now</button>
          </div>
        </div>
      )}
      {showBanner && (
        <div style={card}>
          <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.3rem' }}>{complete ? 'Setup checklist complete' : 'Setup checklist'}</h2>
          <p style={{ margin: '0.2rem 0 0.6rem' }}><strong>{progress.requiredDone} of {progress.requiredTotal} required</strong></p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link href="/documents/checklist" style={primary}>Open checklist</Link>
            {complete && <button type="button" style={btn} disabled={busy} onClick={dismiss}>Hide this</button>}
          </div>
        </div>
      )}
      {trucks.map((t) => {
        const rs = roadsideForTruck(t, ctx, rows);
        const missing = rs.items.filter((r) => !r.done).slice(0, 4);
        return (
          <div key={t.id} style={card}>
            <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.3rem' }}>Roadside ready · Truck {t.unit_number || ''}</h2>
            <p style={muted}>{rs.done} of {rs.total} required cab papers</p>
            {rs.nextExpiry && <p style={muted}>Next date {rs.nextExpiry.expiryOn} · {rs.nextExpiry.title}</p>}
            {missing.length > 0 && (
              <ul style={{ margin: '0.3rem 0', paddingLeft: '1.1rem' }}>
                {missing.map((r) => <li key={`${r.itemKey}:${r.trailerId || ''}:${r.driverId || ''}`}>{r.title}</li>)}
              </ul>
            )}
            <Link href="/documents/checklist">Open the checklist</Link>
          </div>
        );
      })}
      {drivers.map((d) => {
        const fileRows = driverFileRows(d.id, rows);
        const missing = fileRows.filter((r) => r.level === 'required' && !r.done);
        return (
          <div key={d.id} style={card}>
            <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.3rem' }}>Driver file · {d.name || 'Driver'}</h2>
            <p style={muted}>{missing.length ? `${missing.length} required item${missing.length === 1 ? '' : 's'} still open.` : 'Required driver-file items are done.'}</p>
            <p style={muted}>Drug and alcohol records are not included in this file.</p>
            <button type="button" style={primary} disabled={busy} onClick={() => download(d)}>Download PDF</button>
          </div>
        );
      })}
      {office && soon.length > 0 && (
        <div style={card}>
          <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.3rem' }}>Coming up</h2>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {soon.map((e) => <li key={`${e.ruleKey}:${e.period}`}><strong>{e.due}</strong> {e.title}</li>)}
          </ul>
          <p style={muted}><Link href="/documents/checklist">Open the compliance calendar</Link></p>
        </div>
      )}
      {!office && (
        <p style={{ ...muted, marginTop: '0.75rem' }}><Link href="/documents/checklist">Equipment and binder</Link></p>
      )}
      {msg && <p role="alert" style={{ color: 'var(--danger)' }}>{msg}</p>}
    </section>
  );
}
