'use client';
// COI request: coverage-gap warnings + "Request COI from agent…" (write → review → confirm → Send now), same pattern
// as Send to broker. Feature-flagged: hidden unless NEXT_PUBLIC_COI_REQUEST_ENABLED is "1"/"true" (server checks too).
import { useEffect, useMemo, useState } from 'react';
import { coiGaps } from '../lib/coiGaps';
import { capLabel } from '../lib/sendCap';
import { formatSentAt } from '../lib/packetDate';
import { newSendKey, attemptOutcome } from '../lib/packetSendClient';

export const COI_FLAG = ['1', 'true'].includes(String(process.env.NEXT_PUBLIC_COI_REQUEST_ENABLED || '').toLowerCase());

const btn = { minHeight: 44, padding: '0 0.9rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, touchAction: 'manipulation' };
const primary = { ...btn, border: 0, background: '#2563eb', color: '#fff', fontWeight: 600, width: '100%' };
const input = { width: '100%', minHeight: 44, fontSize: 16, padding: '0 0.6rem', borderRadius: 8, border: '1px solid #d1d5db', boxSizing: 'border-box' };
const lab = { display: 'block', fontSize: 13, fontWeight: 600, margin: '0.6rem 0 0.25rem' };
const box = { border: '1px solid #d1d5db', borderRadius: 12, padding: '0.75rem', margin: '1rem auto', maxWidth: 536, fontFamily: 'system-ui', background: '#fff' };
const list = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export default function PacketCoiRequest({ load, send, enabled = COI_FLAG, onStepChange }) {
  const [info, setInfo] = useState(null);
  const [step, setStep] = useState('closed'); // closed | write | review | done
  const [d, setD] = useState({ to: '', cc: '', subject: '', body: '', holderName: '', holderAddress: '', loadDate: '' });
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [key, setKey] = useState(null);
  useEffect(() => { onStepChange?.(step); }, [step, onStepChange]);
  useEffect(() => {
    if (!enabled) return;
    load().then((j) => {
      if (j.error) return;
      setInfo(j);
      setD((x) => ({ ...x, to: x.to || j.agent?.email || '', subject: x.subject || j.draft.subject, body: x.body || j.draft.body, holderName: x.holderName || j.certHolder?.name || '' }));
    });
  }, [load, enabled]);
  const gaps = useMemo(() => (info ? coiGaps({ policies: info.policies, profile: { min_auto_liability: info.minimums?.auto_liability, min_cargo: info.minimums?.cargo }, loadDate: d.loadDate || null, certHolder: { name: d.holderName, address: d.holderAddress } }) : []), [info, d.loadDate, d.holderName, d.holderAddress]);
  if (!enabled || !info) return null;
  const outside = info.allowedDomains ? [...new Set([...list(d.to), ...list(d.cc)])].filter((e) => !info.allowedDomains.includes(e.split('@')[1])) : [];
  const capFull = info.sendCap && info.sendCap.used >= info.sendCap.cap;
  const body = (resend) => ({ to: d.to, cc: d.cc, subject: d.subject, body: d.body, certHolder: { name: d.holderName, address: d.holderAddress }, loadDate: d.loadDate || undefined, confirm: true, idempotencyKey: key, ...(resend ? { resend: true } : {}) });
  const doSend = async (resend = false) => {
    setBusy(true); setErr(null);
    const r = await send(body(resend));
    setBusy(false);
    if (r.sendCap) setInfo((i) => ({ ...i, sendCap: r.sendCap }));
    if (r.ok) { setInfo((i) => ({ ...i, requests: r.requests || i.requests })); setStep('done'); setOk(false); setKey(null); return; }
    if (r.requests) setInfo((i) => ({ ...i, requests: r.requests }));
    if (r.alreadySent) return setErr('already');
    if (r.status === 0 || r.unknown || r.pending) {
      const h = await load().catch(() => null);
      if (h && !h.error) setInfo(h);
      const o = h && !h.error ? attemptOutcome(h.requests, key) : null;
      if (o === 'sent') { setStep('done'); return; }
      return setErr(o === 'not-sent' ? 'Network problem. Nothing was sent. You can press Send now again.' : 'We couldn’t confirm whether this email went out. Don’t send again yet; refresh in a minute.');
    }
    setErr(r.error);
  };
  return (
    <section aria-label="Certificate of insurance" data-testid="coi-panel" style={box}>
      <h2 style={{ fontSize: 16, margin: '0 0 0.4rem' }}>Certificate of insurance</h2>
      {info.setupNeeded && <p style={{ fontSize: 14, color: '#92400e' }}>COI requests need a database update that hasn’t been applied yet.</p>}
      {gaps.length > 0 ? <ul data-testid="coi-gaps" style={{ fontSize: 14, paddingLeft: '1.1rem', margin: '0 0 0.5rem' }}>
        {gaps.map((g, i) => <li key={g.code + i} style={{ color: g.severity === 'error' ? '#b91c1c' : '#92400e' }}>{g.text}</li>)}
      </ul> : <p style={{ fontSize: 14, color: '#065f46' }}>No coverage gaps found.</p>}
      {info.requests?.length > 0 && <ul style={{ fontSize: 13, paddingLeft: '1.1rem', color: '#374151' }}>
        {info.requests.map((q) => <li key={q.id}>{q.confirmed ? 'Requested' : 'Not confirmed:'} {formatSentAt(q.sent_at)} from {(q.to || []).join(', ')}{q.cert_holder_name ? ` (holder ${q.cert_holder_name})` : ''}</li>)}
      </ul>}
      {!info.canSend ? null : !info.agent?.email ? <p style={{ fontSize: 14, color: '#6b7280' }}>Add your insurance agent on the Company page to request a COI.</p>
        : step === 'closed' || step === 'done' ? <>
          {step === 'done' && <p role="status" style={{ fontSize: 14, color: '#065f46' }}>COI requested. Replies go to {info.replyTo}.</p>}
          <button style={primary} onClick={() => { setStep('write'); setErr(null); }}>{info.requests?.length ? 'Request again…' : 'Request COI from agent…'}</button>
        </>
        : step === 'write' ? <form onSubmit={(e) => { e.preventDefault(); setStep('review'); setOk(false); setErr(null); setKey(newSendKey()); }}>
          <label style={lab} htmlFor="coi-to">Agent email</label>
          <input id="coi-to" style={input} type="email" multiple required value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} />
          <label style={lab} htmlFor="coi-cc">CC (optional)</label>
          <input id="coi-cc" style={input} type="email" multiple value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} />
          <label style={lab} htmlFor="coi-hn">Certificate holder (broker name)</label>
          <input id="coi-hn" style={input} required maxLength={200} value={d.holderName} onChange={(e) => setD({ ...d, holderName: e.target.value })} />
          <label style={lab} htmlFor="coi-ha">Certificate holder address</label>
          <textarea id="coi-ha" style={{ ...input, minHeight: 64, padding: '0.5rem 0.6rem' }} maxLength={500} value={d.holderAddress} onChange={(e) => setD({ ...d, holderAddress: e.target.value })} />
          <label style={lab} htmlFor="coi-ld">Load date (optional)</label>
          <input id="coi-ld" style={input} type="date" value={d.loadDate} onChange={(e) => setD({ ...d, loadDate: e.target.value })} />
          <label style={lab} htmlFor="coi-subj">Subject</label>
          <input id="coi-subj" style={input} required maxLength={200} value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          <label style={lab} htmlFor="coi-body">Message</label>
          <textarea id="coi-body" style={{ ...input, minHeight: 160, padding: '0.5rem 0.6rem' }} required value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
          {outside.length > 0 && <p role="alert" style={{ fontSize: 14, color: '#b91c1c' }}>Sending is limited to {info.allowedDomains.join(', ')} for now. Not allowed: {outside.join(', ')}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...btn, flex: 1 }} onClick={() => setStep('closed')}>Cancel</button>
            <button type="submit" style={{ ...primary, flex: 2, ...(outside.length ? { background: '#9ca3af', opacity: 0.6, cursor: 'not-allowed' } : {}) }} disabled={outside.length > 0}>Review email</button>
          </div></form>
        : <div data-testid="coi-review">
          <p style={{ fontSize: 14, margin: '0 0 0.5rem' }}><strong>Check this before sending.</strong> It goes out as soon as you press Send now.</p>
          <dl style={{ fontSize: 14, margin: 0 }}>
            <dt style={{ fontWeight: 600 }}>From</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.from}</dd>
            <dt style={{ fontWeight: 600 }}>Replies go to</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.replyTo}</dd>
            <dt style={{ fontWeight: 600 }}>To</dt><dd style={{ margin: '0 0 0.3rem' }}>{list(d.to).join(', ')}</dd>
            {list(d.cc).length > 0 && <><dt style={{ fontWeight: 600 }}>CC</dt><dd style={{ margin: '0 0 0.3rem' }}>{list(d.cc).join(', ')}</dd></>}
            <dt style={{ fontWeight: 600 }}>Subject</dt><dd style={{ margin: '0 0 0.3rem' }}>{d.subject}</dd>
          </dl>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem' }}>{d.body}</pre>
          {info.sendCap && <p data-testid="coi-cap" style={{ fontSize: 13, color: capFull ? '#b91c1c' : '#6b7280', margin: '0 0 0.4rem' }}>Monthly emails: {capLabel(info.sendCap)}</p>}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15, margin: '0.5rem 0', minHeight: 44 }}>
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ width: 22, height: 22 }} /> I reviewed this email.
          </label>
          {err === 'already' ? <div role="alertdialog" aria-label="Request again?" style={{ border: '1px solid #f59e0b', background: '#fffbeb', borderRadius: 8, padding: '0.6rem', fontSize: 14 }}>
            <p style={{ margin: '0 0 0.5rem' }}>A COI was already requested for this packet. Request again?</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ ...btn, flex: 1 }} onClick={() => setErr(null)} disabled={busy}>Cancel</button>
              <button style={{ ...primary, flex: 2, background: '#b45309' }} disabled={busy} onClick={() => doSend(true)}>{busy ? 'Sending…' : 'Yes, request again'}</button>
            </div></div>
          : <>{err && <p role="alert" style={{ fontSize: 14, color: '#b91c1c' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...btn, flex: 1 }} onClick={() => setStep('write')} disabled={busy}>Edit</button>
            <button style={{ ...primary, flex: 2, background: '#059669', opacity: ok && !busy && !capFull ? 1 : 0.5 }} disabled={!ok || busy || capFull} onClick={() => doSend(false)}>{busy ? 'Sending…' : 'Send now'}</button>
          </div></>}
        </div>}
    </section>
  );
}
