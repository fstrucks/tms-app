'use client';
// Step F: Send the filled packet to the broker. Three steps: write (to/cc/subject/body) → review → Send.
// Nothing is sent until the user presses "Send now" on the review step with the confirm box ticked.
import { useEffect, useState } from 'react';
import { formatPacketDate } from '../lib/packetDate';

const btn = { minHeight: 44, padding: '0 0.9rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, touchAction: 'manipulation' };
const primary = { ...btn, border: 0, background: '#2563eb', color: '#fff', fontWeight: 600, width: '100%' };
const input = { width: '100%', minHeight: 44, fontSize: 16, padding: '0 0.6rem', borderRadius: 8, border: '1px solid #d1d5db', boxSizing: 'border-box' };
const lab = { display: 'block', fontSize: 13, fontWeight: 600, margin: '0.6rem 0 0.25rem' };
const box = { border: '1px solid #d1d5db', borderRadius: 12, padding: '0.75rem', margin: '1rem auto', maxWidth: 536, fontFamily: 'system-ui', background: '#fff' };

export default function PacketSendBroker({ load, send, filledAt }) {
  const [info, setInfo] = useState(null);
  const [step, setStep] = useState('closed'); // closed | write | review | done
  const [d, setD] = useState({ to: '', cc: '', subject: '', body: '' });
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { load().then((j) => { if (!j.error) { setInfo(j); setD((x) => ({ ...x, subject: x.subject || j.draft.subject, body: x.body || j.draft.body })); } }); }, [load, filledAt]);
  if (!info || (!info.canSend && !info.sends?.length)) return null;
  const list = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const outside = info.allowedDomains ? [...list(d.to), ...list(d.cc)].filter((e) => !info.allowedDomains.includes(e.split('@')[1])) : [];
  const doSend = async () => {
    setBusy(true); setErr(null);
    const r = await send({ ...d, confirm: true });
    setBusy(false);
    if (r.error) return setErr(r.error);
    setInfo((i) => ({ ...i, sends: r.sends, sent_at: r.sent_at })); setStep('done'); setOk(false);
  };
  return (
    <section aria-label="Send to broker" style={box}>
      <h2 style={{ fontSize: 16, margin: '0 0 0.4rem' }}>Send to broker {info.sends?.length > 0 && <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#fff', background: '#059669' }}>Sent</span>}</h2>
      {info.sends?.length > 0 && <ul style={{ fontSize: 14, paddingLeft: '1.1rem', margin: '0 0 0.5rem' }}>
        {info.sends.map((s) => <li key={s.id || s.sent_at}>Sent {formatPacketDate(s.sent_at)} {new Date(s.sent_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} to {s.to.join(', ')}{s.cc?.length ? ` (cc ${s.cc.join(', ')})` : ''}</li>)}
      </ul>}
      {info.setupNeeded && <p style={{ fontSize: 14, color: '#92400e' }}>Sending needs a database update that hasn’t been applied yet.</p>}
      {!info.canSend ? null : !info.filled ? <p style={{ fontSize: 14, color: '#6b7280' }}>Fill the packet first, then you can email it to the broker.</p>
        : step === 'closed' || step === 'done' ? <>
          {step === 'done' && <p role="status" style={{ fontSize: 14, color: '#065f46' }}>Sent. Broker replies go to {info.replyTo}.</p>}
          <button style={primary} onClick={() => { setStep('write'); setErr(null); }}>{info.sends?.length ? 'Send again…' : 'Send to broker…'}</button>
        </>
        : step === 'write' ? <form onSubmit={(e) => { e.preventDefault(); setStep('review'); setOk(false); }}>
          <label style={lab} htmlFor="ps-to">Broker email</label>
          <input id="ps-to" style={input} type="email" multiple required autoComplete="email" inputMode="email" value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="broker@example.com" />
          <label style={lab} htmlFor="ps-cc">CC (optional)</label>
          <input id="ps-cc" style={input} type="email" multiple inputMode="email" value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} />
          <label style={lab} htmlFor="ps-subj">Subject</label>
          <input id="ps-subj" style={input} required maxLength={200} value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          <label style={lab} htmlFor="ps-body">Message</label>
          <textarea id="ps-body" style={{ ...input, minHeight: 160, padding: '0.5rem 0.6rem' }} required value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
          <p style={{ fontSize: 13, color: '#6b7280' }}>Attachment: {info.filename}</p>
          {outside.length > 0 && <p role="alert" style={{ fontSize: 14, color: '#b91c1c' }}>Sending is limited to {info.allowedDomains.join(', ')} for now. Not allowed: {outside.join(', ')}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...btn, flex: 1 }} onClick={() => setStep('closed')}>Cancel</button>
            <button type="submit" style={{ ...primary, flex: 2 }} disabled={outside.length > 0}>Review email</button>
          </div></form>
        : <div data-testid="send-review">
          <p style={{ fontSize: 14, margin: '0 0 0.5rem' }}><strong>Check this before sending.</strong> It goes out as soon as you press Send now.</p>
          <dl style={{ fontSize: 14, margin: 0 }}>
            <dt style={{ fontWeight: 600 }}>From</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.from}</dd>
            <dt style={{ fontWeight: 600 }}>Replies go to</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.replyTo}</dd>
            <dt style={{ fontWeight: 600 }}>To</dt><dd style={{ margin: '0 0 0.3rem' }}>{list(d.to).join(', ')}</dd>
            {list(d.cc).length > 0 && <><dt style={{ fontWeight: 600 }}>CC</dt><dd style={{ margin: '0 0 0.3rem' }}>{list(d.cc).join(', ')}</dd></>}
            <dt style={{ fontWeight: 600 }}>Subject</dt><dd style={{ margin: '0 0 0.3rem' }}>{d.subject}</dd>
            <dt style={{ fontWeight: 600 }}>Attachment</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.filename}{filledAt ? ` (filled ${formatPacketDate(filledAt)})` : ''}</dd>
          </dl>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem' }}>{d.body}</pre>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15, margin: '0.5rem 0', minHeight: 44 }}>
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ width: 22, height: 22 }} /> I reviewed this email and the attached PDF.
          </label>
          {err && <p role="alert" style={{ fontSize: 14, color: '#b91c1c' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...btn, flex: 1 }} onClick={() => setStep('write')} disabled={busy}>Edit</button>
            <button style={{ ...primary, flex: 2, background: '#059669', opacity: ok && !busy ? 1 : 0.5 }} disabled={!ok || busy} onClick={doSend}>{busy ? 'Sending…' : 'Send now'}</button>
          </div>
        </div>}
    </section>
  );
}
