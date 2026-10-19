'use client';

// /dispatch/boards: Load boards (phase 1). Buttons open each board's own site (config: lib/loadBoards.js), and
// "Save a load from a board" creates a load with any number of stops (2–20). The owner's load is inserted under the
// owner's RLS, then public.dispatch_save_stops saves the stops. Management and dispatchers save through
// public.dispatch_create_load (migration 20261019000100): one call, the load goes on the OWNER's account. No board APIs yet.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SignInLink from '../../components/SignInLink';
import StopsEditor, { Field, STOP_STYLES } from '../../components/StopsEditor';
import { getSupabase, supabaseConfigError, hasSession } from '../../lib/supabase';
import { fmtMoney } from '../../lib/loads';
import { pickupStop, deliveryStop } from '../../lib/loadTabs';
import { companyOwnerStatus } from '../../lib/accountOwner';
import { fetchDispatchContext, fetchDispatchLoads, formToStops, blankStop, saveStops, createLoad } from '../../lib/dispatch';
import { LOAD_BOARDS, OTHER_BOARD, EMPTY_BOARD_FORM, buildBoardLoad, createBoardLoad, boardLoads, showDispatchNav } from '../../lib/loadBoards';
import DispatchHeaderLinks from '../DispatchHeaderLinks';

const s = {
  ...STOP_STYLES,
  main: { padding: '1rem var(--gutter)', fontFamily: 'system-ui', maxWidth: 820, margin: '0 auto' },
  link: { color: 'var(--primary)' },
  boardBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', textDecoration: 'none', fontWeight: 600, textAlign: 'center' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.6rem' },
  pri: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, fontSize: 16, cursor: 'pointer' },
  note: { background: 'var(--info-bg)', color: 'var(--text)', borderRadius: 8, padding: '0.6rem 0.75rem', fontSize: '0.9rem', margin: '0 0 0.75rem' },
  row: { display: 'block', padding: '0.6rem 0', borderTop: '1px solid var(--divider)', color: 'var(--text)', textDecoration: 'none' },
};
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
const startStops = (tz) => [blankStop('pickup', tz), blankStop('delivery', tz)];
const fmtDay = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const place = (st) => (st ? [st.city, st.state].filter(Boolean).join(', ') : '—');

export default function LoadBoardsPage() {
  const supabase = getSupabase();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState({ status: 'loading' });
  const [tz] = useState(browserTz);
  const [form, setForm] = useState(EMPTY_BOARD_FORM);
  const [stops, setStops] = useState(() => startStops(browserTz()));
  const [errors, setErrors] = useState({});
  const [stopErrors, setStopErrors] = useState({});
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load(u) {
    setState({ status: 'loading' });
    if (!(await hasSession(supabase))) return setState({ status: 'error' });
    const own = await companyOwnerStatus(supabase, u.id);
    if (own.owner) {
      const { data, error } = await supabase.from('loads').select('id, status, broker_name, broker_load_number, rate, notes, created_at, stops(*)')
        .like('notes', 'Load board:%').order('created_at', { ascending: false }).limit(50);
      if (error) console.error('[boards] list', error);
      return setState({ status: 'ready', role: 'owner', loads: boardLoads(data || []) });
    }
    const ctx = await fetchDispatchContext(supabase);
    if (!ctx.error && !ctx.setup && ctx.companies.length) {
      const company = ctx.companies[0];
      const res = await fetchDispatchLoads(supabase);
      return setState({ status: 'ready', role: company.role, company, loads: boardLoads((res.loads || []).filter((l) => l.owner_id === company.owner_id)) });
    }
    setState({ status: 'ready', role: 'none', loads: [] });
  }

  useEffect(() => {
    if (!supabase) return setChecking(false);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (event === 'INITIAL_SESSION') setChecking(false);
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && u) setTimeout(() => load(u), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setMsg(null); };
  const canSave = state.role === 'owner' || ((state.role === 'management' || state.role === 'dispatcher') && !!state.company?.owner_id);

  async function save(e) {
    e.preventDefault();
    if (!canSave || saving) return;
    const b = buildBoardLoad(form, { userId: user.id });
    const st = formToStops(stops, { browserTz: tz });
    setErrors(b.errors); setStopErrors(st.errors);
    if (!b.load || !st.payload) return setMsg({ err: true, text: 'Check the highlighted fields.' });
    setSaving(true); setMsg(null);
    try {
      const r = state.role === 'owner'
        ? await createBoardLoad(supabase, { load: b.load, stops: st.payload }, { saveStops })
        : await createLoad(supabase, state.company.owner_id, b.load, st.payload);
      if (!r.ok) { console.error('[boards] save', r.cause); return setMsg({ err: true, text: r.error }); }
      router.push(loadHref(r.id));
    } finally { setSaving(false); }
  }

  const loadHref = (id) => (state.role === 'owner' ? `/loads/${id}` : `/dispatch/${id}`);

  return (
    <main style={s.main}>
      <h1 style={{ fontSize: '1.4rem', margin: '0.5rem 0 0.25rem' }}>Load boards</h1>
      {showDispatchNav(state.role) && <DispatchHeaderLinks active="boards" role={state.role} />}
      {supabaseConfigError ? <p style={{ color: 'var(--danger)' }}>{supabaseConfigError}</p>
        : checking ? <p style={s.muted}>Checking sign-in…</p>
        : !user ? <p>Please <SignInLink style={s.link}>sign in</SignInLink> to use the load boards.</p>
        : state.status === 'loading' ? <p style={s.muted}>Loading…</p>
        : state.status === 'error' ? <p role="alert" style={{ color: 'var(--danger)' }}>Your session has expired or is still loading. Reload, or sign in again.</p>
        : state.role === 'none' ? <p style={s.muted} data-testid="boards-not-member">Load boards are for the company owner, management and dispatchers. <Link href="/" style={s.link}>Home</Link>.</p>
        : (
          <>
            <section style={s.card} aria-labelledby="boards-open">
              <h2 id="boards-open" style={{ fontSize: '1.05rem', marginTop: 0 }}>Open a board</h2>
              <p style={{ ...s.muted, marginTop: 0 }}>Each board opens in a new tab. Sign in there with your own account.</p>
              <div style={s.grid2} data-testid="board-links">
                {LOAD_BOARDS.map((b) => (
                  <a key={b.key} href={b.url} target="_blank" rel="noopener noreferrer" style={s.boardBtn} data-board={b.key}>{b.label} ↗</a>
                ))}
              </div>
            </section>

            <form onSubmit={save} noValidate data-testid="board-form">
              <section style={s.card} aria-labelledby="boards-save">
                <h2 id="boards-save" style={{ fontSize: '1.05rem', marginTop: 0 }}>Save a load from a board</h2>
                {state.role !== 'owner' && <p style={s.note} data-testid="boards-owner-note">The load is saved to the owner’s account, so the owner sees it in Loads.</p>}
                <fieldset disabled={!canSave} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                  <div style={s.grid2}>
                    <label style={s.label}>Load board *
                      <select value={form.board} onChange={(e) => set('board')(e.target.value)} aria-invalid={errors.board ? 'true' : undefined} style={{ ...s.input, ...(errors.board ? { borderColor: 'var(--danger)' } : null) }}>
                        <option value="">Pick a board…</option>
                        {LOAD_BOARDS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                        <option value={OTHER_BOARD}>Other…</option>
                      </select>
                      {errors.board && <p style={s.err}>{errors.board}</p>}
                    </label>
                    {form.board === OTHER_BOARD && <Field label="Board name" required value={form.board_other} onChange={set('board_other')} error={errors.board_other} />}
                    <Field label="Broker" required value={form.broker_name} onChange={set('broker_name')} error={errors.broker_name} />
                    <Field label="Broker load #" value={form.broker_load_number} onChange={set('broker_load_number')} />
                    <Field label="Rate" required inputMode="decimal" placeholder="e.g. 1,280" value={form.rate} onChange={set('rate')} error={errors.rate} />
                    <Field label="Miles" inputMode="numeric" value={form.miles} onChange={set('miles')} error={errors.miles} />
                    <Field label="Commodity" value={form.commodity} onChange={set('commodity')} />
                    <Field label="Weight (lb)" inputMode="numeric" value={form.weight} onChange={set('weight')} error={errors.weight} />
                    <Field label="Equipment" placeholder="e.g. 53' dry van" value={form.equipment_type} onChange={set('equipment_type')} />
                  </div>
                  <div style={{ marginTop: '0.6rem' }}><Field label="Notes" textarea value={form.notes} onChange={set('notes')} error={errors.notes} /></div>
                </fieldset>
              </section>
              <StopsEditor stops={stops} setStops={setStops} stopErrors={stopErrors} browserTz={tz} onEdit={() => setMsg(null)} disabled={!canSave} testId="board-stops" />
              {msg && <p role={msg.err ? 'alert' : 'status'} style={{ color: msg.err ? 'var(--danger)' : 'var(--success)' }}>{msg.text}</p>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: '1rem' }}>
                <button type="submit" disabled={!canSave || saving} style={s.pri} data-testid="board-save">{saving ? 'Saving…' : 'Save load'}</button>
              </div>
            </form>

            <section style={s.card} aria-labelledby="boards-recent" data-testid="board-loads">
              <h2 id="boards-recent" style={{ fontSize: '1.05rem', margin: 0 }}>Saved from boards</h2>
              {state.loads.length === 0 ? <p style={{ ...s.muted, marginBottom: 0 }}>No loads saved from a board yet.</p> : state.loads.map((l) => {
                const pu = pickupStop(l), del = deliveryStop(l);
                return (
                  <Link key={l.id} href={loadHref(l.id)} style={s.row} data-testid="board-load-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{place(pu)} → {place(del)}</span>
                      {state.role === 'owner' && l.rate != null && <span style={{ whiteSpace: 'nowrap' }}>{fmtMoney(l.rate)}</span>}
                    </div>
                    <div style={s.muted}>{l.board} · {l.broker_name || 'Broker'} · {pu?.appointment_start ? `Pickup ${fmtDay(pu.appointment_start)}` : 'Pickup date not set'}</div>
                  </Link>
                );
              })}
            </section>
          </>
        )}
    </main>
  );
}
