'use client';
// Load page → Export screen (delivered or later; owner, management, dispatchers). The user picks what goes in, sees the
// exact list in order, then downloads one PDF or emails it. Email only goes out after the user reviews the recipient,
// the attachment list and its size, and presses Send.
import { useEffect, useState } from 'react';
import { showExport, defaultSelection, previewList, selectionQuery, NOTE_MAX, looksLikeAccounting, formatBytes, downloadedName } from '../lib/loadExport';
import { newSendKey, outsideRecipients } from '../lib/packetSendClient';
import { parseEmails } from '../lib/packetSend';

const btn = { minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.95rem', cursor: 'pointer' };
const row = { display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.92rem', minHeight: 32 };
const muted = { margin: 0, fontSize: '0.88rem', color: 'var(--text-muted)' };

export default function LoadExport({ supabase, load, cardStyle }) {
  const visible = showExport(load);
  const [info, setInfo] = useState(null);
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [mail, setMail] = useState(null); // GET /send result
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const [review, setReview] = useState(null); // { to, list, filename, size, key }
  const [acctOk, setAcctOk] = useState(false);
  const [sendErr, setSendErr] = useState(null);
  const [sent, setSent] = useState(null);

  const token = async () => (await supabase.auth.getSession()).data?.session?.access_token || '';
  useEffect(() => {
    if (!visible || !open || info) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/loads/${load.id}/export`, { cache: 'no-store', headers: { Authorization: `Bearer ${await token()}` } });
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) { setInfo(j); setSel(defaultSelection(j.options)); } else setErr(j.error || 'Couldn’t check this load’s documents.');
      } catch { if (live) setErr('Couldn’t check this load’s documents.'); }
    })();
    return () => { live = false; };
  }, [visible, open, info, load?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!visible || !open || mail) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/loads/${load.id}/send`, { cache: 'no-store', headers: { Authorization: `Bearer ${await token()}` } });
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        setMail(r.ok ? j : { sends: [], unavailable: true });
        if (r.ok && j.prefill) setTo((t) => t || j.prefill);
      } catch { if (live) setMail({ sends: [], unavailable: true }); }
    })();
    return () => { live = false; };
  }, [visible, open, mail, load?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notes saved in the Load notes box: re-read the options so "Print the load's notes" appears/updates.
  useEffect(() => { setInfo(null); setReview(null); }, [load?.notes]);
  // Any checklist change invalidates a review (size / too-large are recomputed on the next Review).
  useEffect(() => { setReview(null); setSendErr(null); setNote(null); }, [sel]); // an old “Downloaded …” would name the wrong file

  if (!visible) return null;
  const o = info?.options;
  const preview = previewList(o, sel || {});
  const set = (k, v) => setSel((s) => ({ ...s, [k]: v }));
  const toggleDoc = (id, on) => setSel((s) => ({ ...s, docIds: on ? [...s.docIds, id] : s.docIds.filter((x) => x !== id) }));

  async function get() {
    setErr(null); setNote(null); setBusy(true);
    try {
      let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* default */ }
      const r = await fetch(`/api/loads/${load.id}/export?${selectionQuery(sel, tz)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${await token()}` } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Couldn’t build the packet. Please try again.'); }
      const name = downloadedName(r.headers.get('content-disposition'), sel, info?.fileNames);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      const skipped = decodeURIComponent(r.headers.get('x-packet-skipped-names') || '');
      setNote(`Downloaded ${name}.${skipped ? ` Left out because it couldn’t be read: ${skipped}.` : ''}`);
    } catch (e) { setErr(e.message || 'Couldn’t build the packet. Please try again.'); }
    setBusy(false);
  }

  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
  const toList = parseEmails(to).list || [];
  const outside = mail ? outsideRecipients(to, '', mail.allowedDomains ?? null) : [];
  const acct = toList.filter(looksLikeAccounting);

  // Step 1: build the same PDF as the download (not saved) to show its exact size before anything is sent.
  async function startReview() {
    setSendErr(null); setSent(null); setAcctOk(false);
    const p = parseEmails(to, { required: true });
    if (p.error) { setSendErr(p.error.replace('broker ', '')); return; }
    if (outside.length) { setSendErr(`Sending is limited to ${(mail.allowedDomains || []).join(', ')} for now. Not allowed: ${outside.join(', ')}.`); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/loads/${load.id}/export?${selectionQuery(sel, tz())}`, { cache: 'no-store', headers: { Authorization: `Bearer ${await token()}` } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Couldn’t build the packet. Please try again.'); }
      const name = downloadedName(r.headers.get('content-disposition'), sel, info?.fileNames);
      const size = (await r.blob()).size;
      setReview({ to: p.list, list: preview, filename: name, size, key: newSendKey() });
    } catch (e) { setSendErr(e.message || 'Couldn’t build the packet. Please try again.'); }
    setBusy(false);
  }
  // Step 2: the explicit Send. The same key is reused if the user retries this review, so it can't send twice.
  async function send() {
    setSendErr(null); setBusy(true);
    try {
      const r = await fetch(`/api/loads/${load.id}/send`, { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: review.to, note: msg, sel, tz: tz(), idempotencyKey: review.key, confirm: true, confirmAccounting: acctOk }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'The email wasn’t sent. Please try again.');
      setSent(`Sent to ${(j.to || review.to).join(', ')}.${j.duplicate ? ' (It had already gone out; it was not sent again.)' : ''}${j.warning ? ` ${j.warning}` : ''}`);
      setReview(null); setMail((m) => ({ ...m, sends: j.sends?.length ? j.sends : m?.sends || [], sendCap: j.sendCap || m?.sendCap }));
    } catch (e) { setSendErr(e.message); }
    setBusy(false);
  }
  const tooBig = review && mail?.maxBytes && review.size > mail.maxBytes;
  const fmtWhen = (t) => { try { return new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return t; } };

  const missing = (o?.missing || []).map((t) => (t === 'pod' ? 'POD' : 'rate confirmation'));
  return (
    <div style={cardStyle} data-testid="load-export">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Export</h2>
      {!open ? (
        <button type="button" style={btn} data-testid="load-export-open" onClick={() => setOpen(true)}>⬇ Export or invoice</button>
      ) : !o || !sel ? (!err && <p style={muted}>Checking documents…</p>) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <p style={muted}>Choose what goes in the PDF.</p>
          <label style={row}><input type="checkbox" data-testid="load-export-invoice" checked={sel.invoice} onChange={(e) => set('invoice', e.target.checked)} />
            Invoice page {info.invoiceNumber ? `(${info.invoiceNumber})` : '(prints as a draft until the invoice is finalized)'}</label>
          {o.docs.map((d) => (
            <label key={d.id} style={{ ...row, opacity: d.supported ? 1 : 0.6 }}>
              <input type="checkbox" data-testid={`load-export-doc-${d.id}`} disabled={!d.supported} checked={d.supported && sel.docIds.includes(d.id)} onChange={(e) => toggleDoc(d.id, e.target.checked)} />
              {d.label}{d.name ? `: ${d.name}` : ''}{!d.supported && ' (can’t be added: only PDF, JPG and PNG files)'}
            </label>
          ))}
          {!o.docs.length && <p style={muted}>No documents on this load yet.</p>}
          {o.stopTimes.available && <label style={row}><input type="checkbox" data-testid="load-export-stoptimes" checked={sel.stopTimes} onChange={(e) => set('stopTimes', e.target.checked)} /> Stop times (arrival and departure for each stop)</label>}
          {o.loadNotes.available && <label style={row}><input type="checkbox" data-testid="load-export-loadnotes" checked={sel.loadNotes} onChange={(e) => set('loadNotes', e.target.checked)} /> Print the load’s notes</label>}
          <label style={{ fontSize: '0.92rem' }}>Note for this packet (optional)
            <textarea data-testid="load-export-note" maxLength={NOTE_MAX} rows={3} value={sel.note} onChange={(e) => set('note', e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 4, borderRadius: 8, border: '1px solid var(--border)', padding: 8, background: 'var(--surface)', color: 'var(--text)' }} />
          </label>
          {!!missing.length && <p data-testid="load-export-missing" style={{ ...muted, color: 'var(--warning, #b45309)' }}>No {missing.join(' or ')} on this load.</p>}
          <div data-testid="load-export-preview" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
            <strong style={{ fontSize: '0.92rem' }}>The PDF will include, in this order:</strong>
            {preview.length ? <ol style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: '0.9rem' }}>{preview.map((p, i) => <li key={i}>{p}</li>)}</ol> : <p style={muted}>Nothing selected yet.</p>}
          </div>
          <div><button type="button" style={btn} disabled={busy || !preview.length} data-testid="load-export-download" onClick={get}>{busy ? 'Building…' : `Download PDF${sel.invoice ? ' with invoice' : ' without invoice'}`}</button></div>
          <div data-testid="load-export-email" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, display: 'grid', gap: 6 }}>
            <strong style={{ fontSize: '0.95rem' }}>Email this PDF</strong>
            {mail?.setupNeeded ? <p style={muted} data-testid="load-export-email-setup">Emailing isn’t available yet (a database update is pending). You can still download the PDF.</p>
              : mail && mail.configured === false ? <p style={muted} data-testid="load-export-email-off">Email sending isn’t set up yet. You can still download the PDF.</p>
              : mail?.unavailable ? <p style={muted}>Emailing isn’t available right now. You can still download the PDF.</p>
              : !mail ? <p style={muted}>Checking email…</p> : (<>
              <label style={{ fontSize: '0.92rem' }}>To (the broker contact; separate several with commas)
                <input type="email" multiple data-testid="load-export-to" value={to} onChange={(e) => { setTo(e.target.value); setReview(null); }}
                  style={{ display: 'block', width: '100%', marginTop: 4, minHeight: 40, borderRadius: 8, border: '1px solid var(--border)', padding: '0 8px', background: 'var(--surface)', color: 'var(--text)' }} />
              </label>
              {!!outside.length && <p role="alert" data-testid="load-export-outside" style={{ ...muted, color: 'var(--danger)' }}>Sending is limited to {(mail.allowedDomains || []).join(', ')} for now. Not allowed: {outside.join(', ')}.</p>}
              {!!acct.length && <p data-testid="load-export-acct-warn" style={{ ...muted, color: 'var(--warning)' }}>{acct.join(', ')} looks like an accounting address. Paperwork normally goes to the broker contact.</p>}
              <label style={{ fontSize: '0.92rem' }}>Short note in the email (optional)
                <textarea data-testid="load-export-email-note" maxLength={NOTE_MAX} rows={2} value={msg} onChange={(e) => { setMsg(e.target.value); setReview(null); }}
                  style={{ display: 'block', width: '100%', marginTop: 4, borderRadius: 8, border: '1px solid var(--border)', padding: 8, background: 'var(--surface)', color: 'var(--text)' }} />
              </label>
              {mail.sendCap && <p style={muted}>{mail.sendCap.used} of {mail.sendCap.cap} emails used this month.</p>}
              {!review ? (
                <div><button type="button" style={btn} disabled={busy || !preview.length || !toList.length || !!outside.length} data-testid="load-export-review" onClick={startReview}>Review email…</button></div>
              ) : (
                <div data-testid="load-export-confirm" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'grid', gap: 4, fontSize: '0.9rem' }}>
                  <div><strong>To:</strong> {review.to.join(', ')}</div>
                  <div data-testid="load-export-replyto">{mail.replyTo
                    ? <>Replies will go to <strong>{mail.replyTo}</strong>.</>
                    : <>No reply-to email is set, so replies go to {mail.from || 'the sending address'}. Set one under <a href="/company" style={{ color: 'var(--primary)' }}>Company</a> → Reply-to email.</>}</div>
                  <div><strong>Attachment:</strong> {review.filename} ({formatBytes(review.size)})</div>
                  <ol style={{ margin: 0, paddingLeft: 20 }}>{review.list.map((p, i) => <li key={i}>{p}</li>)}</ol>
                  {tooBig ? (<>
                    <p role="alert" data-testid="load-export-toobig" style={{ margin: 0, color: 'var(--danger)' }}>This PDF is too large to email ({formatBytes(review.size)}; the limit is {formatBytes(mail.maxBytes)}). Download it instead, or leave out some pictures.</p>
                    <div><button type="button" style={btn} onClick={get} disabled={busy}>Download PDF</button></div>
                  </>) : (<>
                    {!!acct.length && <label style={row}><input type="checkbox" data-testid="load-export-acct-ok" checked={acctOk} onChange={(e) => setAcctOk(e.target.checked)} /> Yes, send it to {acct.join(', ')}</label>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={{ ...btn, background: 'var(--primary)', color: 'var(--on-primary)', borderColor: 'transparent' }} disabled={busy || (acct.length && !acctOk)} data-testid="load-export-send" onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
                      <button type="button" style={btn} disabled={busy} onClick={() => setReview(null)}>Cancel</button>
                    </div>
                  </>)}
                </div>
              )}
              {sendErr && <p role="alert" data-testid="load-export-send-error" style={{ ...muted, color: 'var(--danger)' }}>{sendErr}</p>}
              {sent && <p role="status" data-testid="load-export-sent-ok" style={{ ...muted, color: 'var(--success)' }}>{sent}</p>}
            </>)}
            {!!mail?.sends?.length && (
              <div data-testid="load-export-sent">
                <strong style={{ fontSize: '0.92rem' }}>Sent</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: '0.88rem' }}>
                  {mail.sends.map((h) => <li key={h.id}>{fmtWhen(h.sent_at)}: {h.by} to {h.to.join(', ')}, {h.with_invoice ? 'with invoice' : 'without invoice'}{h.confirmed ? '' : ' (not confirmed)'}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      {note && <p role="status" style={{ color: 'var(--success)', fontSize: '0.9rem', margin: '6px 0 0' }}>{note}</p>}
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
