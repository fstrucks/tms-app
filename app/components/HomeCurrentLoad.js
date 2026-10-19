'use client';

// Home page "Current load" card (Marc's hybrid, Oct 18 2026): Option A for one pickup + one drop, Option B
// (next stop first + countdown, other stops folded but open) for multi-stop loads; "Up next" (next 2 booked)
// beside it on desktop and below it on phones. Loads come from public.visible_loads() (owner + company members,
// rate nulled server-side for drivers unless the load's show_rate_to_driver is on). Before migration
// 20261018000600 it falls back to the owner's own select and members get no card.
// Selection and formatting rules live in lib/homeCurrentLoad.js.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { hasSession } from '../lib/supabase';
import { StatusBadge, fullAddress, fmtApptWindow, fmtApptDate, fmtNumber } from '../lib/loads';
import { sortedStops, pickupStop } from '../lib/loadTabs';
import { milesSourceNote, isMissingMilesSource } from '../lib/loadMiles';
import { Loading, LoadError } from './DataState';
import CurrentLoadPanels from './CurrentLoadPanels';
import {
  fetchHomeLoads, pickCurrentLoad, moreLine, upNext, layoutFor, routeLabel, canShowRate, rateText,
  nextStopIndex, countdown, pickupNumberText, cardAudience, STOP_LABEL, TONE_COLORS, TONE_BG,
} from '../lib/homeCurrentLoad';

const s = {
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.9rem', background: '#fff', minWidth: 0 },
  lbl: { fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#6b7280' },
  muted: { color: '#6b7280', fontSize: '0.875rem' },
  route: { fontSize: '1.15rem', fontWeight: 700, margin: '0.4rem 0 0.15rem' },
  chip: { display: 'inline-block', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.25rem 0.5rem', fontSize: '0.82rem', background: '#f9fafb', margin: '0 0.4rem 0.4rem 0' },
  btn: { flex: '1 1 140px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid #2563eb', color: '#1d4ed8', background: '#fff', fontWeight: 600, fontSize: '0.95rem', textDecoration: 'none', cursor: 'pointer' },
  btnPri: { background: '#2563eb', color: '#fff' },
  link: { color: '#2563eb', fontSize: '0.9rem' },
};

function StopBlock({ load, stop, big = false }) {
  if (!stop) return null;
  const appt = fmtApptWindow(stop.appointment_start, stop.appointment_end, stop.timezone);
  return (
    <div data-testid="home-stop" style={{ minWidth: 0 }}>
      <div style={s.lbl}>{STOP_LABEL(stop)}</div>
      {stop.company_name && <div style={{ fontWeight: 600, fontSize: big ? '1.1rem' : '1rem' }}>{stop.company_name}</div>}
      <div style={{ fontSize: '0.9rem', color: '#374151' }}>{fullAddress(stop) || '—'}</div>
      <div style={{ fontSize: '0.9rem', marginTop: 2 }}><b>Appt</b> {appt || 'not set'}</div>
      {stop.stop_type === 'pickup' && <div data-testid="home-pickup-number" style={{ fontSize: '0.9rem', marginTop: 2 }}>{pickupNumberText(load, stop)}</div>}
    </div>
  );
}

function Countdown({ stop, now }) {
  const c = countdown(stop, now);
  if (!c) return null;
  return (
    <span data-testid="home-countdown" data-tone={c.tone}
      style={{ display: 'inline-block', marginTop: 6, padding: '0.15rem 0.55rem', borderRadius: 999, fontSize: '0.82rem', fontWeight: 600, color: TONE_COLORS[c.tone], background: TONE_BG[c.tone] }}>
      ⏱ {c.text}
    </span>
  );
}

function OptionA({ load }) {
  const st = sortedStops(load);
  return (
    <div className="home-stops" data-layout="A">
      <StopBlock load={load} stop={st[0]} />
      <StopBlock load={load} stop={st[st.length - 1]} />
    </div>
  );
}

function OptionB({ load, now }) {
  const st = sortedStops(load);
  const ni = nextStopIndex(load, now);
  const next = st[ni];
  const others = st.map((x, i) => ({ x, i })).filter(({ i }) => i !== ni);
  return (
    <div data-layout="B">
      <div style={{ ...s.lbl, color: '#1e40af', marginBottom: 4 }}>Next stop · {ni + 1} of {st.length}</div>
      <StopBlock load={load} stop={next} big />
      <Countdown stop={next} now={now} />
      <details open style={{ marginTop: 10, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
        <summary style={{ ...s.muted, cursor: 'pointer' }}>Other stops ({others.length})</summary>
        {others.map(({ x, i }) => (
          <div key={x.id ?? i} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <span aria-hidden="true" style={{ ...s.muted, minWidth: 18 }}>{i + 1}.</span>
            <StopBlock load={load} stop={x} />
          </div>
        ))}
      </details>
    </div>
  );
}

function LoadCard({ pick, docPath, onOpenRateCon, now, audience }) {
  const owner = audience === 'owner';
  const { load, kind } = pick;
  const layout = layoutFor(load);
  const miles = load.total_miles > 0 ? `${fmtNumber(load.total_miles)} mi` : null;
  const src = miles ? milesSourceNote({ load }) : null;
  const pu = pickupStop(load);
  const more = moreLine(pick);
  return (
    <section data-testid="home-current-load" data-kind={kind} data-layout={layout} aria-label={kind === 'next' ? 'Next load' : 'Current load'}
      style={{ ...s.card, ...(kind === 'next' ? { border: '2px dashed #d1d5db' } : { border: '2px solid #bfdbfe' }) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ ...s.lbl, color: kind === 'next' ? '#6b7280' : '#1e40af' }}>{kind === 'next' ? 'Next load' : 'Current load'}</div>
        <StatusBadge status={load.status} />
      </div>
      {kind === 'next' && <p style={{ ...s.muted, margin: '0.4rem 0 0' }}>Nothing on the road right now. This is your next booked load.</p>}
      <div style={s.route}>{routeLabel(load)}</div>
      <div style={{ ...s.muted, marginBottom: 12 }}>
        {load.broker_load_number ? `Load #${load.broker_load_number}` : 'Load'}{load.broker_name ? ` · ${load.broker_name}` : ''}
      </div>
      {layout === 'A' ? <OptionA load={load} /> : <OptionB load={load} now={now} />}
      <div style={{ marginTop: 12 }}>
        {miles && <span style={s.chip}>{miles}{src && <span style={{ color: '#6b7280' }}> · {src}</span>}</span>}
        {layout === 'A' && pu && <span style={s.chip}>{pickupNumberText(load, pu)}</span>}
        {canShowRate(load, audience) && <span data-testid="home-rate" style={{ ...s.chip, fontWeight: 600, color: '#065f46' }}>{rateText(load)}</span>}
      </div>
      {/* Members can't open the owner's load page or rate con file yet (own-row RLS / private Storage). */}
      {owner && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <Link href={`/loads/${load.id}`} style={{ ...s.btn, ...s.btnPri }}>Open load</Link>
          {docPath && <button type="button" onClick={onOpenRateCon} style={s.btn}>📄 Rate con</button>}
        </div>
      )}
      {more && (owner ? <p style={{ margin: '0.6rem 0 0', fontSize: '0.9rem' }}><Link href="/loads?tab=active" style={s.link}>{more} →</Link></p>
        : <p style={{ ...s.muted, margin: '0.6rem 0 0' }}>{more}</p>)}
    </section>
  );
}

function UpNext({ loads, owner }) {
  return (
    <section data-testid="home-up-next" aria-label="Up next" style={s.card}>
      <div style={s.lbl}>Up next</div>
      {loads.length === 0 && <p style={{ ...s.muted, margin: '0.5rem 0' }}>No other booked loads.</p>}
      {loads.map((l, i) => {
        const pu = pickupStop(l);
        const d = fmtApptDate(pu?.appointment_start, pu?.timezone);
        const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '0.6rem 0', borderBottom: i < loads.length - 1 ? '1px solid #f1f5f9' : 'none', color: 'inherit', textDecoration: 'none', fontSize: '0.9rem' };
        const inner = (<><span style={{ minWidth: 0 }}><StatusBadge status={l.status} /> {routeLabel(l)}</span><span style={{ ...s.muted, whiteSpace: 'nowrap' }}>{d || 'No date'}</span></>);
        return owner ? <Link key={l.id} href={`/loads/${l.id}`} style={rowStyle}>{inner}</Link> : <div key={l.id} style={rowStyle}>{inner}</div>;
      })}
      {owner && <Link href="/loads" style={s.link}>All loads →</Link>}
    </section>
  );
}

export default function HomeCurrentLoad({ supabase, user }) {
  const [audience, setAudience] = useState(null); // 'owner' | 'member' | 'hidden' (member before the migration) | null = not known yet
  const [loads, setLoads] = useState(null);
  const [error, setError] = useState(null);
  const [docPath, setDocPath] = useState(null);
  const [openErr, setOpenErr] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const req = useRef(0);

  async function load() {
    const r = ++req.current;
    setError(null);
    if (!(await hasSession(supabase))) { if (r === req.current) setError('Your session has expired or is still loading. Tap Retry, or sign in again.'); return; }
    // Members of someone else's company see no loads under own-row RLS, so they get no card (never a false "No loads").
    const m = await supabase.from('company_members').select('user_id, role').eq('user_id', user.id);
    if (r !== req.current) return;
    if (m.error) { console.error('[home] members', m.error); return setError("Couldn't load your current load."); }
    const who = cardAudience(user.id, m.data);
    const res = await fetchHomeLoads(supabase, { missingSource: isMissingMilesSource });
    if (r !== req.current) return;
    if (res.error) { console.error('[home] loads', res.error); return setError("Couldn't load your current load."); }
    // Before 20261018000600 a member's own-row select is always empty: no card rather than a false "No loads".
    setAudience(who === 'member' && !res.viaRpc ? 'hidden' : who);
    setNow(Date.now());
    setLoads(res.loads);
  }

  useEffect(() => { if (supabase && user) load(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);

  const pick = loads ? pickCurrentLoad(loads, now) : null;
  const curId = audience === 'owner' ? (pick?.load?.id || null) : null; // rate con files: owner's Storage only

  // Newest rate con linked to the card's load; the button is hidden when there is none.
  useEffect(() => {
    setDocPath(null);
    if (!curId) return;
    let live = true;
    supabase.from('documents').select('file_path, created_at').eq('load_id', curId).eq('doc_type', 'rate_confirmation')
      .order('created_at', { ascending: false }).limit(1)
      .then(({ data, error }) => { if (!live) return; if (error) console.error('[home] rate con', error); setDocPath(data?.[0]?.file_path || null); });
    return () => { live = false; };
  }, [curId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openRateCon() {
    setOpenErr(null);
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(docPath, 300);
    if (error || !data?.signedUrl) { console.error('[home] open rate con', error); return setOpenErr("Couldn't open the rate con. Please try again."); }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  if (audience === 'hidden') return null;
  const owner = audience === 'owner';
  if (error) return <div style={{ marginTop: '1rem' }}><LoadError message={error} onRetry={load} /></div>;
  if (!loads) return <div style={{ marginTop: '1rem', maxWidth: 480 }}><Loading label="Loading your current load…" /></div>;

  if (pick.kind === 'empty') {
    return (
      <section data-testid="home-current-load" data-kind="empty" style={{ ...s.card, border: '2px dashed #d1d5db', marginTop: '1rem', maxWidth: 560 }}>
        <div style={s.lbl}>Current load</div>
        <p style={{ fontWeight: 600, margin: '0.4rem 0 0.75rem' }}>No active or booked loads</p>
        {owner && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link href="/loads/new" style={{ ...s.btn, ...s.btnPri }}>+ New load</Link>
            <Link href="/documents" style={s.btn}>🧾 Scan rate con</Link>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="home-grid" style={{ marginTop: '1rem' }}>
      <div style={{ minWidth: 0 }}>
        <CurrentLoadPanels enabled={pick.kind === 'current'} load={pick.load} supabase={supabase} audience={audience}>
          <LoadCard pick={pick} docPath={docPath} onOpenRateCon={openRateCon} now={now} audience={audience} />
        </CurrentLoadPanels>
        {openErr && <p role="alert" style={{ color: '#b91c1c', fontSize: '0.9rem' }}>{openErr}</p>}
      </div>
      <UpNext loads={upNext(loads, pick.load, now)} owner={owner} />
    </div>
  );
}
