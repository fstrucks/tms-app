'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from '../lib/supabase';
import { fmtMoney } from '../lib/loads';
import { fetchPaged, buildWeeks, localISO, aggregate, summarize, REVENUE_RULE } from '../lib/dashboard';

const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 960, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.85rem', marginBottom: '0.75rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem' },
  row: { display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.88rem', padding: '0.15rem 0' },
  muted: { color: '#6b7280' },
  error: { color: '#b91c1c' },
  link: { color: '#2563eb' },
  tab: (on) => ({ padding: '0.4rem 0.9rem', borderRadius: 8, border: '1px solid #d1d5db', background: on ? '#2563eb' : '#fff', color: on ? '#fff' : '#111', fontSize: '0.9rem' }),
};

const mi = (n) => `${Math.round(n).toLocaleString('en-US')} mi`;
const rpm = (n) => (n == null || !isFinite(n) ? '—' : `$${Number(n).toFixed(2)}/mi`);
const range = (w) => {
  const last = new Date(w.end); last.setDate(last.getDate() - 1);
  const f = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(w.start)} – ${f(last)}`;
};

function Chart({ rows }) {
  const W = 320, H = 120, pad = 18;
  const max = Math.max(1, ...rows.flatMap((w) => [w.revenue, w.expenseTotal]));
  const slot = (W - pad) / rows.length;
  const bw = Math.max(3, slot / 2 - 3);
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const zero = y(0);
  const netPts = rows.map((w, i) => `${pad + i * slot + slot / 2},${Math.min(H - 2, Math.max(2, y(w.net)))}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Weekly revenue, expenses and net" style={{ display: 'block' }}>
      <line x1={pad} x2={W} y1={zero} y2={zero} stroke="#e5e7eb" />
      {rows.map((w, i) => {
        const x = pad + i * slot + 2;
        return (
          <g key={w.key}>
            <rect x={x} y={y(w.revenue)} width={bw} height={Math.max(0, zero - y(w.revenue))} fill="#2563eb" rx="2"><title>{`${range(w)} revenue ${fmtMoney(w.revenue)}`}</title></rect>
            <rect x={x + bw + 1} y={y(w.expenseTotal)} width={bw} height={Math.max(0, zero - y(w.expenseTotal))} fill="#f87171" rx="2"><title>{`${range(w)} expenses ${fmtMoney(w.expenseTotal)}`}</title></rect>
            <text x={x + bw} y={H - 4} fontSize="8" textAnchor="middle" fill="#6b7280">{w.start.getMonth() + 1}/{w.start.getDate()}</text>
          </g>
        );
      })}
      <polyline points={netPts} fill="none" stroke="#059669" strokeWidth="1.5" />
    </svg>
  );
}

// Tiny per-week bar: revenue vs expenses relative to the period max.
function MiniBar({ w, max }) {
  const pct = (v) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <svg width="100%" height="14" style={{ display: 'block', margin: '0.35rem 0' }} aria-hidden="true">
      <rect x="0" y="1" width={pct(w.revenue)} height="5" rx="2" fill="#2563eb" />
      <rect x="0" y="8" width={pct(w.expenseTotal)} height="5" rx="2" fill="#f87171" />
    </svg>
  );
}

function Stats({ w, cats }) {
  return (
    <>
      <div style={s.row}><span style={s.muted}>Booked revenue ({w.loads} load{w.loads === 1 ? '' : 's'})</span><strong>{fmtMoney(w.revenue)}</strong></div>
      {w.missingRate > 0 && (
        <div style={{ ...s.row, fontSize: '0.8rem', color: '#b45309' }}><span>{w.missingRate} load{w.missingRate === 1 ? '' : 's'} missing rate</span><span>not in revenue</span></div>
      )}
      <div style={s.row}><span style={s.muted}>Load miles (loads.total_miles)</span><span>{mi(w.rpmMiles)}</span></div>
      <div style={s.row}><span style={s.muted}>Logged loaded / deadhead</span><span>{mi(w.miles.loaded)} / {mi(w.miles.deadhead)}</span></div>
      <div style={s.row}><span style={s.muted}>Logged total miles</span><span>{mi(w.totalMiles)}</span></div>
      {(w.miles.personal > 0 || w.miles.other > 0) && (
        <div style={{ ...s.row, fontSize: '0.8rem' }}><span style={s.muted}>Personal / other (not in RPM)</span><span>{mi(w.miles.personal)} / {mi(w.miles.other)}</span></div>
      )}
      <div style={s.row}><span style={s.muted}>Loaded RPM (rate ÷ load miles)</span><strong>{rpm(w.loadedRpm)}</strong></div>
      <div style={s.row}><span style={s.muted}>All-in RPM (revenue ÷ logged loaded + deadhead)</span><strong>{rpm(w.allInRpm)}</strong></div>
      <div style={{ borderTop: '1px solid #f1f5f9', margin: '0.35rem 0' }} />
      {cats.filter((c) => w.expenses[c] > 0).map((c) => (
        <div key={c} style={{ ...s.row, fontSize: '0.82rem' }}><span style={{ ...s.muted, textTransform: 'capitalize' }}>{c}</span><span>{fmtMoney(w.expenses[c])}</span></div>
      ))}
      <div style={s.row}><span style={s.muted}>Expenses</span><span>{fmtMoney(w.expenseTotal)}</span></div>
      <div style={{ ...s.row, fontWeight: 700 }}><span>Net</span><span style={{ color: w.net < 0 ? '#b91c1c' : '#065f46' }}>{fmtMoney(w.net)}</span></div>
    </>
  );
}

export default function DashboardPage() {
  const supabase = getSupabase();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [n, setN] = useState(8);
  const weeksRef = useRef(8);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);

  async function load(weeksCount) {
    setBusy(true); setError(null);
    try {
      const weeks = buildWeeks(weeksCount);
      const from = weeks[0].start, to = weeks[weeks.length - 1].end;
      const fromISO = localISO(from), toISO = localISO(to);
      const fromTs = from.toISOString(), toTs = to.toISOString();
      const loadCols = 'id, status, rate, total_miles, created_at, stops(sequence, appointment_start)';

      // Candidate loads: any stop appointment in range, or created in range. Week assignment happens client-side.
      const [stopsRes, createdRes, milesRes, expRes] = await Promise.all([
        fetchPaged((o) => supabase.from('stops').select('load_id', o).gte('appointment_start', fromTs).lt('appointment_start', toTs).order('id')),
        fetchPaged((o) => supabase.from('loads').select(loadCols, o).gte('created_at', fromTs).lt('created_at', toTs).order('id')),
        fetchPaged((o) => supabase.from('mileage_entries').select('id, miles, source, entry_date', o).gte('entry_date', fromISO).lt('entry_date', toISO).order('id')),
        fetchPaged((o) => supabase.from('expenses').select('id, amount, category, expense_date', o).gte('expense_date', fromISO).lt('expense_date', toISO).order('id')),
      ]);
      const byId = new Map(createdRes.rows.map((l) => [l.id, l]));
      const missing = [...new Set(stopsRes.rows.map((r) => r.load_id))].filter((id) => id && !byId.has(id));
      for (let i = 0; i < missing.length; i += 100) {
        const { data, error } = await supabase.from('loads').select(loadCols).in('id', missing.slice(i, i + 100));
        if (error) throw error;
        for (const l of data || []) byId.set(l.id, l);
      }
      setTruncated([stopsRes, createdRes, milesRes, expRes].some((r) => r.truncated));
      setRows(aggregate(weeks, { loads: [...byId.values()], entries: milesRes.rows, expenses: expRes.rows }));
    } catch (err) {
      console.error('dashboard load', err);
      setError('Could not load the dashboard, please try again.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && u) setTimeout(() => load(weeksRef.current), 0);
      if (event === 'SIGNED_OUT') setRows(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  function pick(k) { weeksRef.current = k; setN(k); if (user) load(k); }

  const total = rows ? summarize(rows) : null;
  const cats = total ? Object.keys(total.expenses) : [];
  const max = rows ? Math.max(1, ...rows.flatMap((w) => [w.revenue, w.expenseTotal])) : 1;

  return (
    <main style={s.main}>
      <p style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <Link href="/" style={s.link}>← Home</Link>
        <Link href="/loads" style={s.link}>Loads</Link>
        <Link href="/mileage" style={s.link}>Mileage</Link>
        <Link href="/expenses" style={s.link}>Expenses</Link>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.5rem', margin: '0.25rem 0' }}>Weekly dashboard</h1>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {[4, 8].map((k) => <button key={k} onClick={() => pick(k)} disabled={busy} style={s.tab(n === k)}>{k} weeks</button>)}
        </div>
      </div>
      {supabaseConfigError ? <p style={s.error}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <Link href="/login" style={s.link}>sign in</Link> to see your dashboard.</p>
        : (
          <>
            {error && <p style={s.error}>{error}</p>}
            {busy && <p style={s.muted}>Loading…</p>}
            {truncated && <p style={{ ...s.muted, fontSize: '0.8rem' }}>Some data could not be fully loaded (row limit reached); totals may be incomplete.</p>}
            {rows && total && (
              <>
                <div style={s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Last {n} weeks</h2>
                    <span style={{ ...s.muted, fontSize: '0.8rem' }}>{range(total)}</span>
                  </div>
                  <Chart rows={rows} />
                  <div style={{ display: 'flex', gap: '0.9rem', fontSize: '0.75rem', ...s.muted, marginBottom: '0.4rem' }}>
                    <span><span style={{ color: '#2563eb' }}>■</span> Booked revenue</span>
                    <span><span style={{ color: '#f87171' }}>■</span> Expenses</span>
                    <span><span style={{ color: '#059669' }}>—</span> Net</span>
                  </div>
                  <p style={{ ...s.muted, fontSize: '0.75rem', margin: '0 0 0.4rem' }}>
                    Booked revenue {REVENUE_RULE === 'completed_only' ? 'counts delivered / invoiced / paid loads only' : 'excludes cancelled / canceled / TONU / void loads'}.
                  </p>
                  <Stats w={total} cats={cats} />
                </div>
                <div style={s.grid}>
                  {[...rows].reverse().map((w) => (
                    <div key={w.key} style={{ ...s.card, marginBottom: 0 }}>
                      <div style={{ fontWeight: 600 }}>{range(w)}</div>
                      <MiniBar w={w} max={max} />
                      <Stats w={w} cats={cats} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
    </main>
  );
}
