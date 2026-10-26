'use client';
// Step F: Send the filled packet to the broker. Three steps: write (to/cc/subject/body) → review → Send.
// Nothing is sent until the user presses "Send now" on the review step with the confirm box ticked.
import { useEffect, useState } from 'react';
import { formatPacketDate, formatSentAt } from '../lib/packetDate';
import { capLabel } from '../lib/sendCap';
import { checkSendSize, fmtMB } from '../lib/companyDocs';
import { newSendKey as newKey, attemptOutcome, outsideRecipients, primaryButtonStyle, autoCcFor } from '../lib/packetSendClient';

const btn = { minHeight: 44, padding: '0 0.9rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 15, touchAction: 'manipulation' };
const primary = { ...btn, border: 0, background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, width: '100%' };
const input = { width: '100%', minHeight: 44, fontSize: 16, padding: '0 0.6rem', borderRadius: 8, border: '1px solid var(--border)', boxSizing: 'border-box' };
const lab = { display: 'block', fontSize: 13, fontWeight: 600, margin: '0.6rem 0 0.25rem' };
const box = { border: '1px solid var(--border)', borderRadius: 12, padding: '0.75rem', margin: '1rem auto', maxWidth: 536, fontFamily: 'system-ui', background: 'var(--surface)' };

export default function PacketSendBroker({ load, send, filledAt, onStepChange }) {
  const [info, setInfo] = useState(null);
  const [step, setStep] = useState('closed'); // closed | write | review | done
  const [d, setD] = useState({ to: '', cc: '', subject: '', body: '' });
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [key, setKey] = useState(null); // one idempotency key per send attempt; reused on retries of that attempt
  const [again, setAgain] = useState(false); // "already sent, send again?" confirm showing
  const [warn, setWarn] = useState(null);
  const [att, setAtt] = useState({}); // PR #84: vault type → ticked
  const [loadErr, setLoadErr] = useState(null); // GET failed: show it instead of hiding Send to broker
  const [tries, setTries] = useState(0);
  useEffect(() => { onStepChange?.(step); }, [step, onStepChange]);
  useEffect(() => { load().then((j) => { if (j.error) return setLoadErr(j.error); setLoadErr(null); setInfo(j); setD((x) => ({ ...x, subject: x.subject || j.draft.subject, body: x.body || j.draft.body })); setAtt((a) => vaultDefaults(j, a)); }, () => setLoadErr('Network problem.')); }, [load, filledAt, tries]);
  if (!info && loadErr) return <section aria-label="Send to broker" data-testid="send-load-error" style={box}><h2 style={{ fontSize: 16, margin: '0 0 0.4rem' }}>Send to broker</h2><p role="alert" style={{ fontSize: 14, color: 'var(--danger)' }}>Couldn’t load the send options. {loadErr}</p><button style={btn} onClick={() => setTries((n) => n + 1)}>Retry</button></section>;
  if (!info || (!info.canSend && !info.sends?.length)) return null;
  const list = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const outside = outsideRecipients(list(d.to).join(','), list(d.cc).join(','), info.allowedDomains);
  const copyTo = autoCcFor(info.autoCc, list(d.to)); // PACKET_CC_EMAIL copy, unless it's already a To address
  const reviewCc = [...new Set([...list(d.cc).filter((e) => !list(d.to).includes(e)), ...(copyTo ? [copyTo] : [])])];
  const capFull = !!info.sendCap && info.sendCap.used >= info.sendCap.cap;
  const confirmedSends = (info.sends || []).filter((x) => x.confirmed || x.postmark_message_id);
  const lastSend = confirmedSends[0] || info.sends?.[0];
  // PR #84 (6A): each ticked vault file goes as its own PDF. Running total vs the 7.5 MB raw / 10 MB encoded cap.
  const vaultOpts = info.vault?.options || [];
  const ticked = vaultOpts.filter((o) => o.available && att[o.type]);
  const size = checkSendSize([info.vault?.packetSize || 0, ...ticked.map((o) => o.size || 0)]);
  const sizeKnown = info.vault?.packetSize != null && ticked.every((o) => o.size != null);
  const attachNames = [info.filename, ...ticked.map((o) => o.filename)];
  const finish = (r) => { setInfo((i) => ({ ...i, sends: r.sends || i.sends, sent_at: r.sent_at, sendCap: r.sendCap || i.sendCap })); setWarn(r.warning || null); setStep('done'); setOk(false); setAgain(false); setKey(null); };
  const doSend = async (resend = false) => {
    if (!resend && info.sends?.length) return setAgain(true); // ask first: "already sent on X. Send again?"
    const k = key || newKey(); if (!key) setKey(k);
    setBusy(true); setErr(null); setAgain(false);
    const r = await send({ ...d, confirm: true, idempotencyKey: k, attachDocumentIds: ticked.map((o) => o.id), ...(resend ? { resend: true } : {}) });
    if (r.refresh) { const h = await load().catch(() => null); if (h && !h.error) { setInfo(h); setAtt((a) => vaultDefaults(h, a)); } }
    if (r.ok) { setBusy(false); return finish(r); }
    if (r.sends) setInfo((i) => ({ ...i, sends: r.sends }));
    if (r.sendCap) setInfo((i) => ({ ...i, sendCap: r.sendCap }));
    if (r.alreadySent) { setBusy(false); return setAgain(true); }
    if (r.status === 0 || r.unknown || r.pending || (r.status >= 500 && !/Nothing was sent/.test(r.error || ''))) {
      // The connection dropped or the result is unclear: the email may have gone out. Check before suggesting a retry.
      const h = await load().catch(() => null);
      setBusy(false);
      if (h && !h.error) setInfo(h);
      const o = h && !h.error ? attemptOutcome(h.sends, k) : null;
      if (o === 'sent') return finish({ sends: h.sends, warning: 'The connection dropped, but the email did go out. Don’t send it again.' });
      if (o === 'unknown' || r.unknown || r.pending) return setErr('We couldn’t confirm whether this email went out. Don’t send again yet. Check with the broker or refresh this page in a minute.');
      if (o === 'not-sent') return setErr(`${r.status === 0 ? 'Network problem.' : r.error} Nothing was sent. You can press Send now again.`);
      return setErr('Network problem, and we couldn’t check the send history. Refresh the page and check the history before sending again.');
    }
    setBusy(false);
    setErr(r.error);
  };
  return (
    <section aria-label="Send to broker" style={box}>
      <h2 style={{ fontSize: 16, margin: '0 0 0.4rem' }}>Send to broker {info.sends?.length > 0 && <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: 'var(--on-success)', background: 'var(--success-solid)' }}>Sent</span>}</h2>
      {info.sends?.length > 0 && <ul style={{ fontSize: 14, paddingLeft: '1.1rem', margin: '0 0 0.5rem' }}>
        {info.sends.map((s) => <li key={s.id || s.sent_at} data-testid="send-row">{s.confirmed || s.postmark_message_id ? 'Sent' : 'Not confirmed:'} {formatSentAt(s.sent_at)} to {(s.to || []).join(', ')}{s.cc?.length ? ` (cc ${s.cc.join(', ')})` : ''}</li>)}
      </ul>}
      {info.setupNeeded && <p style={{ fontSize: 14, color: 'var(--warning)' }}>Sending needs a database update that hasn’t been applied yet.</p>}
      {!info.canSend ? null : !info.filled ? <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Fill the packet first, then you can email it to the broker.</p>
        : step === 'closed' || step === 'done' ? <>
          {step === 'done' && <p role="status" style={{ fontSize: 14, color: 'var(--success)' }}>Sent. Broker replies go to {info.replyTo || info.from}.</p>}
          {step === 'done' && warn && <p role="alert" style={{ fontSize: 14, color: 'var(--warning)' }}>{warn}</p>}
          <button style={primary} onClick={() => { setStep('write'); setErr(null); setWarn(null); }}>{info.sends?.length ? 'Send again…' : 'Send to broker…'}</button>
        </>
        : step === 'write' ? <form onSubmit={(e) => { e.preventDefault(); setStep('review'); setOk(false); setAgain(false); setKey(null); }}>
          <label style={lab} htmlFor="ps-to">Broker email</label>
          <input id="ps-to" style={input} type="email" multiple required autoComplete="email" inputMode="email" value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="broker@example.com" />
          <label style={lab} htmlFor="ps-cc">CC (optional)</label>
          <input id="ps-cc" style={input} type="email" multiple inputMode="email" value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} />
          <label style={lab} htmlFor="ps-subj">Subject</label>
          <input id="ps-subj" style={input} required maxLength={200} value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          <label style={lab} htmlFor="ps-body">Message</label>
          <textarea id="ps-body" style={{ ...input, minHeight: 160, padding: '0.5rem 0.6rem' }} required value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
          {copyTo && <p data-testid="send-copy" style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0.4rem 0 0' }}>A copy goes to {copyTo}.</p>}
          {vaultOpts.length > 0 ? <fieldset data-testid="send-attachments" style={{ border: '1px solid var(--divider)', borderRadius: 8, padding: '0.5rem 0.6rem', margin: '0.6rem 0' }}>
            <legend style={{ fontSize: 13, fontWeight: 600, padding: '0 4px' }}>Attachments</legend>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, minHeight: 40 }}><input type="checkbox" checked disabled style={{ width: 20, height: 20 }} /> {info.filename}{info.vault?.packetSize != null ? ` (${fmtMB(info.vault.packetSize)})` : ''}</label>
            {vaultOpts.map((o) => o.available
              ? <div key={o.type}><label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, minHeight: 40 }}>
                  <input type="checkbox" data-testid={`attach-${o.type}`} checked={!!att[o.type]} onChange={(e) => setAtt((a) => ({ ...a, [o.type]: e.target.checked }))} style={{ width: 20, height: 20 }} />
                  {o.label} <span style={{ color: 'var(--text-muted)' }}>{o.filename}{o.size != null ? ` (${fmtMB(o.size)})` : ''}</span></label>
                  {o.warning && <p role="note" style={{ fontSize: 13, color: 'var(--warning)', margin: '0 0 0.3rem 28px' }}>{o.warning}</p>}</div>
              : <p key={o.type} style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0.2rem 0' }}>{o.label}: not on file. <a href="/company#company-documents" style={{ color: 'var(--primary)' }}>Add it</a></p>)}
            <p data-testid="send-size" style={{ fontSize: 13, margin: '0.3rem 0 0', color: size.ok ? 'var(--text-muted)' : 'var(--danger)' }}>{sizeKnown ? `Total ${fmtMB(size.raw)} of 7.5 MB.` : 'Total size is checked when you send (limit 7.5 MB).'}{!size.ok ? ' Too large: untick a file.' : ''}</p>
          </fieldset> : <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Attachment: {info.filename}</p>}
          {outside.length > 0 && <p role="alert" style={{ fontSize: 14, color: 'var(--danger)' }}>Sending is limited to {info.allowedDomains.join(', ')} for now. Not allowed: {outside.join(', ')}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...btn, flex: 1 }} onClick={() => setStep('closed')}>Cancel</button>
            <button type="submit" style={primaryButtonStyle({ ...primary, flex: 2 }, outside.length > 0)} disabled={outside.length > 0} aria-disabled={outside.length > 0}>Review email</button>
          </div></form>
        : <div data-testid="send-review">
          <p style={{ fontSize: 14, margin: '0 0 0.5rem' }}><strong>Check this before sending.</strong> It goes out as soon as you press Send now.</p>
          <dl style={{ fontSize: 14, margin: 0 }}>
            <dt style={{ fontWeight: 600 }}>From</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.from}</dd>
            <dt style={{ fontWeight: 600 }}>Replies go to</dt><dd style={{ margin: '0 0 0.3rem' }}>{info.replyTo || `${info.from} (no reply-to set)`}</dd>
            <dt style={{ fontWeight: 600 }}>To</dt><dd style={{ margin: '0 0 0.3rem' }}>{list(d.to).join(', ')}</dd>
            {reviewCc.length > 0 && <><dt style={{ fontWeight: 600 }}>CC</dt><dd data-testid="send-review-cc" style={{ margin: '0 0 0.3rem' }}>{reviewCc.join(', ')}</dd></>}
            <dt style={{ fontWeight: 600 }}>Subject</dt><dd style={{ margin: '0 0 0.3rem' }}>{d.subject}</dd>
            <dt style={{ fontWeight: 600 }}>{attachNames.length > 1 ? 'Attachments' : 'Attachment'}</dt><dd data-testid="send-review-attachments" style={{ margin: '0 0 0.3rem' }}>{info.filename}{filledAt ? ` (filled ${formatPacketDate(filledAt)})` : ''}{ticked.length ? `, ${ticked.map((o) => o.filename).join(', ')}` : ''}</dd>
          </dl>
          {info.sendCap && <p data-testid="send-cap" style={{ fontSize: 13, color: info.sendCap.used >= info.sendCap.cap ? 'var(--danger)' : 'var(--text-muted)', margin: '0 0 0.4rem' }}>{capLabel(info.sendCap) === 'Monthly limit reached' ? 'Monthly limit reached. Nothing more can be sent this month.' : `Monthly emails: ${capLabel(info.sendCap)}`}</p>}
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, background: 'var(--surface-2)', border: '1px solid var(--divider)', borderRadius: 8, padding: '0.5rem' }}>{d.body}</pre>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15, margin: '0.5rem 0', minHeight: 44 }}>
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ width: 22, height: 22 }} /> I reviewed this email and the attached PDF.
          </label>
          {err && <p role="alert" style={{ fontSize: 14, color: 'var(--danger)' }}>{err}</p>}
          {again && lastSend ? <div role="alertdialog" aria-label="Send again?" data-testid="send-again" style={{ border: '1px solid var(--warning-border)', background: 'var(--warning-bg)', borderRadius: 8, padding: '0.6rem', fontSize: 14 }}>
            <p style={{ margin: '0 0 0.5rem' }}>{lastSend.confirmed || lastSend.postmark_message_id ? `This packet was already sent on ${formatSentAt(lastSend.sent_at)} to ${(lastSend.to || []).join(', ')}.` : `An earlier send on ${formatSentAt(lastSend.sent_at)} wasn’t confirmed and may have gone out.`} Send again?</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ ...btn, flex: 1 }} onClick={() => setAgain(false)} disabled={busy}>Cancel</button>
              <button style={{ ...primary, flex: 2, background: 'var(--warning)' }} disabled={busy} onClick={() => doSend(true)}>{busy ? 'Sending…' : 'Yes, send again'}</button>
            </div></div>
          : <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...btn, flex: 1 }} onClick={() => setStep('write')} disabled={busy}>Edit</button>
            <button style={primaryButtonStyle({ ...primary, flex: 2, background: 'var(--success-solid)', color: 'var(--on-success)' }, !ok || busy || capFull || !size.ok)} disabled={!ok || busy || capFull || !size.ok} onClick={() => doSend(false)}>{busy ? 'Sending…' : 'Send now'}</button>
          </div>}
        </div>}
    </section>
  );
}

// Default ticks (4A): on-file vault docs ticked, a flagged COI unticked. Keeps the user's own choices across reloads.
function vaultDefaults(info, prev = {}) {
  const out = {};
  for (const o of info?.vault?.options || []) if (o.available) out[o.type] = Object.prototype.hasOwnProperty.call(prev, o.type) ? prev[o.type] : !!o.checked;
  return out;
}
