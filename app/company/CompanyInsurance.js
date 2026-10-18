'use client';
// Company page → Insurance: agent (one per company), coverage minimums, and policy lines.
// Policies typed in by owner/management are confirmed; AI suggestions from an uploaded COI stay
// unconfirmed until confirmed here. Upload COI / declarations docs with the existing Scan/Upload (type "COI").
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { COVERAGES, COVERAGE_LABELS, coiGaps } from '../lib/coiGaps';
import { companyGapNotes, suggestMessage, suggestedExpiredLabel, suggestedExpiredNotes, atLeast } from '../lib/coiRequest';
import { laToday } from '../lib/sendCap';

const { call: api } = makeApi(() => getSupabase()?.auth);
const s = {
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  label: { display: 'block', margin: '0.75rem 0 0.35rem', fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0.6rem 0.75rem', fontSize: '1rem', borderRadius: 8, border: '1px solid #d1d5db' },
  btn: { width: '100%', minHeight: 44, padding: '0.7rem', fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.75rem', cursor: 'pointer' },
  small: { minHeight: 44, padding: '0 0.8rem', fontSize: 15, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' },
  err: { color: '#b91c1c', fontSize: 14, margin: '0.25rem 0 0' },
};
const usd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US')}`);
const BLANK = { coverage: 'auto_liability', insurer: '', policy_number: '', limit_amount: '', effective_date: '', expiry_date: '' };

export default function CompanyInsurance() {
  const [st, setSt] = useState({ loading: true });
  const [agent, setAgent] = useState({ name: '', agency: '', email: '', phone: '' });
  const [mins, setMins] = useState({ auto_liability: '', cargo: '' });
  const [np, setNp] = useState(BLANK);
  const [docs, setDocs] = useState([]);
  const [msg, setMsg] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(null); // document id being read by Suggest
  const inFlight = useRef(false); // sync guard: blocks double taps / repeat submits before React re-renders
  const apply = useCallback((j) => {
    if (j.error && !j.setupNeeded) return setSt({ error: j.error });
    setSt({ ...j, loading: false });
    if (j.agent) setAgent({ name: j.agent.name || '', agency: j.agent.agency || '', email: j.agent.email || '', phone: j.agent.phone || '' });
    if (j.minimums) setMins({ auto_liability: String(j.minimums.auto_liability), cargo: String(j.minimums.cargo) });
  }, []);
  const reload = useCallback(() => api('/api/company/insurance').then(apply), [apply]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { getSupabase()?.from('documents').select('id,original_filename,created_at').eq('doc_type', 'coi').order('created_at', { ascending: false }).limit(10).then(({ data }) => setDocs(data || [])); }, []);
  const run = async (fn, ok) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    try { return await runInner(fn, ok); } finally { inFlight.current = false; }
  };
  const runInner = async (fn, ok) => { setBusy(true); setMsg(null); setErrors({}); const r = await fn(); setBusy(false); if (r.error) { setErrors(r.errors || {}); setMsg(r.error); return null; } if (ok) setMsg(ok); return r; };

  if (st.loading) return <section style={s.card}><p>Loading insurance…</p></section>;
  if (st.error) return <section style={s.card}><h2 style={{ margin: 0, fontSize: '1.1rem' }}>Insurance</h2><p role="alert" style={s.err}>{st.error}</p></section>;
  const ed = !!st.canEdit && !st.setupNeeded;
  const field = (obj, set, k, label, extra = {}) => <div key={k}><label htmlFor={`ins-${k}`} style={s.label}>{label}</label>
    {ed ? <input id={`ins-${k}`} style={{ ...s.input, ...(errors[k] ? { borderColor: '#b91c1c' } : null) }} value={obj[k]} onChange={(e) => set({ ...obj, [k]: e.target.value })} {...extra} /> : <div style={{ padding: '0.6rem 0' }}>{obj[k] || '—'}</div>}
    {errors[k] && <p style={s.err}>{errors[k]}</p>}</div>;
  return (
    <section style={s.card} id="company-insurance" aria-label="Insurance" data-testid="company-insurance">
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Insurance</h2>
      {st.setupNeeded && <p style={{ color: '#92400e', fontSize: 14 }}>Insurance info needs a database update that hasn’t been applied yet.</p>}
      <h3 style={{ fontSize: '1rem', margin: '0.75rem 0 0' }}>Insurance agent</h3>
      {field(agent, setAgent, 'name', 'Agent name', { autoComplete: 'off' })}
      {field(agent, setAgent, 'agency', 'Agency')}
      {field(agent, setAgent, 'email', 'Agent email', { inputMode: 'email', type: 'email' })}
      {field(agent, setAgent, 'phone', 'Agent phone', { inputMode: 'tel', type: 'tel' })}
      <h3 style={{ fontSize: '1rem', margin: '1rem 0 0' }}>Coverage minimums</h3>
      {field(mins, setMins, 'auto_liability', 'Auto liability minimum ($)', { inputMode: 'numeric' })}
      {field(mins, setMins, 'cargo', 'Cargo minimum ($)', { inputMode: 'numeric' })}
      {errors.minimums && <p style={s.err}>{errors.minimums}</p>}
      {ed && <button type="button" style={{ ...s.btn, ...(busy ? { opacity: 0.6 } : null) }} disabled={busy}
        onClick={() => run(() => api('/api/company/insurance', { method: 'PUT', body: JSON.stringify({ agent, minimums: mins }) }), 'Insurance info saved.').then((r) => r && apply(r))}>Save agent and minimums</button>}

      <h3 style={{ fontSize: '1rem', margin: '1.25rem 0 0.25rem' }}>Policies</h3>
      {(() => { const notes = companyGapNotes(coiGaps({ policies: st.policies || [], profile: { min_auto_liability: st.minimums?.auto_liability, min_cargo: st.minimums?.cargo }, certHolder: { name: '-', address: '-' }, today: laToday() })).concat(suggestedExpiredNotes(st.policies, laToday())); return notes.length > 0 && <ul data-testid="company-gaps" style={{ fontSize: 14, paddingLeft: '1.1rem', margin: '0 0 0.5rem' }}>{notes.map((g, i) => <li key={g.code + i} style={{ color: g.severity === 'error' ? '#b91c1c' : '#92400e' }}>{g.text}</li>)}</ul>; })()}
      {!(st.policies || []).length && <p style={{ color: '#6b7280', fontSize: 14 }}>No policies yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {(st.policies || []).map((p) => <li key={p.id} data-testid="policy-row" style={{ borderTop: '1px solid #f1f5f9', padding: '0.5rem 0', fontSize: 14 }}>
          <strong>{COVERAGE_LABELS[p.coverage] || p.coverage}</strong> {usd(p.limit_amount)} · {p.insurer || 'insurer ?'} {p.policy_number ? `#${p.policy_number}` : ''} · {p.effective_date || '?'} → {p.expiry_date || '?'}
          {!p.confirmed && (suggestedExpiredLabel(p, laToday())
            ? <span data-testid="suggested-expired" style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: '#fee2e2', color: '#b91c1c', fontSize: 12, fontWeight: 600 }}>{suggestedExpiredLabel(p, laToday())}</span>
            : <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 600 }}>Suggested – check it</span>)}
          {ed && <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {!p.confirmed && <button type="button" style={{ ...s.small, borderColor: '#059669', color: '#065f46' }} disabled={busy} onClick={() => run(() => api('/api/company/insurance/policies', { method: 'PATCH', body: JSON.stringify({ id: p.id, confirm: true }) }), 'Policy confirmed.').then((r) => r?.policy && setSt((x) => ({ ...x, policies: (x.policies || []).map((q) => (q.id === r.policy.id ? r.policy : q)) })))}>Confirm</button>}
            <button type="button" style={{ ...s.small, color: '#b91c1c', borderColor: '#fca5a5' }} disabled={busy} onClick={() => run(() => api('/api/company/insurance/policies', { method: 'DELETE', body: JSON.stringify({ id: p.id }) }), 'Policy removed.').then((r) => r && reload())}>Remove</button>
          </div>}
        </li>)}
      </ul>
      {ed && <>
        <h4 style={{ fontSize: 15, margin: '1rem 0 0' }}>Add a policy</h4>
        <label htmlFor="ins-coverage" style={s.label}>Coverage</label>
        <select id="ins-coverage" style={s.input} value={np.coverage} onChange={(e) => setNp({ ...np, coverage: e.target.value })}>{COVERAGES.map((c) => <option key={c} value={c}>{COVERAGE_LABELS[c]}</option>)}</select>
        {field(np, setNp, 'insurer', 'Insurer')}
        {field(np, setNp, 'policy_number', 'Policy number')}
        {field(np, setNp, 'limit_amount', 'Limit ($)', { inputMode: 'numeric' })}
        {field(np, setNp, 'effective_date', 'Effective date', { type: 'date' })}
        {field(np, setNp, 'expiry_date', 'Expiry date', { type: 'date' })}
        <button type="button" style={{ ...s.btn, ...(busy ? { opacity: 0.6 } : null) }} disabled={busy} onClick={() => run(() => api('/api/company/insurance/policies', { method: 'POST', body: JSON.stringify(np) }), 'Policy added.').then((r) => { if (r) { setNp(BLANK); reload(); } })}>Add policy</button>
        <h4 style={{ fontSize: 15, margin: '1rem 0 0.25rem' }}>Read a COI you uploaded</h4>
        <a href="#vault-coi" data-testid="upload-coi" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, borderRadius: 8, border: '2px solid #2563eb', color: '#1d4ed8', background: '#eff6ff', fontWeight: 600, textDecoration: 'none', marginBottom: 6 }}>Upload COI</a>
        {!docs.length ? <p style={{ color: '#6b7280', fontSize: 14 }}>Upload your COI in Company documents above, then come back here.</p>
          : docs.map((d) => <button key={d.id} type="button" data-testid="suggest-btn" style={{ ...s.small, width: '100%', marginTop: 6, textAlign: 'left', ...(busy ? { opacity: 0.6, cursor: 'not-allowed' } : null) }} disabled={busy} aria-busy={reading === d.id}
            onClick={async () => {
              setReading(d.id);
              const r = await run(() => atLeast(api('/api/company/insurance/suggest', { method: 'POST', body: JSON.stringify({ documentId: d.id }) }))); // busy state stays visible ≥600ms
              setReading(null);
              if (!r) return;
              if (Array.isArray(r.policies)) setSt((x) => ({ ...x, policies: r.policies })); // refresh the list in place
              setMsg(suggestMessage(r));
            }}>
            {reading === d.id ? 'Reading COI…' : `Suggest policies from ${d.original_filename || 'COI'}${docs[0]?.id === d.id ? ' (current)' : ''}`}</button>)}
      </>}
      {msg && <p role="status" style={{ marginTop: '0.75rem', fontSize: 14 }}>{msg}</p>}
    </section>
  );
}
