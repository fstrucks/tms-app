'use client';

import { useEffect, useRef, useState } from 'react';
import ConfirmButton from './ui/ConfirmButton';
import { rateconAddress, parseSenders, copyText, EMAIL_TOTAL_MB } from '../lib/rateconDrafts';

// Documents: the user's secret rate con address (ratecon+<token>@ the inbound domain shown, see rateconDrafts.js), Copy, New address, and an
// optional sender allowlist. Hidden quietly when migration 20261019000200 isn't applied yet.
const s = {
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  muted: { color: 'var(--text-muted)', fontSize: '0.85rem' },
  addr: { fontFamily: 'ui-monospace, monospace', fontSize: 14, wordBreak: 'break-all', background: 'var(--surface-2)', color: 'var(--text)', borderRadius: 8, padding: '0.6rem 0.7rem', margin: '0.4rem 0' },
  btn: { minHeight: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 600, fontSize: 15 },
  primary: { minHeight: 44, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, fontSize: 15 },
  input: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 72, fontSize: 16, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 4, background: 'var(--surface)', color: 'var(--text)' },
};

export default function RateconEmailCard({ supabase, userId }) {
  const [state, setState] = useState('loading'); // loading | ready | off
  const [addr, setAddr] = useState(null);
  const [senders, setSenders] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const addrRef = useRef(null);

  useEffect(() => {
    if (!supabase || !userId) return;
    let live = true;
    supabase.rpc('ratecon_address_get').then(({ data, error }) => {
      if (!live) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.token) { if (error) console.error('[ratecon email] address', error.code); return setState('off'); }
      setAddr(rateconAddress(row.token)); setSenders((row.allowed_senders || []).join('\n')); setState('ready');
    });
    return () => { live = false; };
  }, [supabase, userId]);

  if (state !== 'ready') return null;

  async function copy() {
    const r = await copyText(addr, { node: addrRef.current });
    setMsg(r === 'copied' ? { ok: true, text: 'Copied.' } : { ok: false, text: 'Press and hold the address to copy it.' });
  }
  async function regenerate() {
    const { data, error } = await supabase.rpc('ratecon_address_regenerate');
    if (error || !data) { setMsg({ ok: false, text: "Couldn't make a new address. Please try again." }); return false; }
    setAddr(rateconAddress(data));
    setMsg({ ok: true, text: 'New address ready. Mail sent to the old address is now ignored.' });
    return true;
  }
  async function saveSenders() {
    setSaving(true); setMsg(null);
    const { data, error } = await supabase.rpc('ratecon_set_allowed_senders', { p_senders: parseSenders(senders) });
    setSaving(false);
    if (error) return setMsg({ ok: false, text: /bad_sender/.test(error.message || '') ? 'Use full emails (broker@example.com) or domains (@example.com).' : /too_many/.test(error.message || '') ? 'Up to 20 senders.' : "Couldn't save. Please try again." });
    setSenders((data || []).join('\n'));
    setMsg({ ok: true, text: data?.length ? 'Saved. Only these senders can email you rate cons.' : 'Saved. Anyone with your address can email you rate cons.' });
  }

  return (
    <section style={s.card} data-testid="ratecon-email-card" aria-labelledby="ratecon-email-h">
      <h2 id="ratecon-email-h" style={{ fontSize: '1.1rem', marginTop: 0, marginBottom: '0.25rem' }}>Email rate cons to the app</h2>
      <p style={{ ...s.muted, margin: 0 }}>Forward a rate con PDF to your private address. It shows up below marked “From email”, ready for you to check and tap Create load. Nothing is booked until you do.</p>
      <div ref={addrRef} style={{ ...s.addr, userSelect: 'all', WebkitUserSelect: 'all' }} data-testid="ratecon-address">{addr}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={copy} style={s.primary}>Copy address</button>
        <ConfirmButton label="New address" confirmLabel="Make new address" danger={false}
          prompt="The old address stops working." ariaLabel="Make a new rate con address. The old address stops working." onConfirm={regenerate} />
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ ...s.btn, border: 'none', color: 'var(--primary)', background: 'none' }}>
          {open ? 'Hide sender list' : 'Only allow certain senders'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: '0.5rem' }}>
          <label htmlFor="ratecon-senders" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Allowed senders (optional)</label>
          <textarea id="ratecon-senders" value={senders} onChange={(e) => setSenders(e.target.value)} placeholder={'broker@example.com\n@dispatch.example.com'} style={s.input} />
          <p style={{ ...s.muted, margin: '0.25rem 0' }}>One per line. Leave empty to accept rate cons from anyone who has your address. Mail from anyone else is ignored.</p>
          <button type="button" onClick={saveSenders} disabled={saving} style={{ ...s.btn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save senders'}</button>
        </div>
      )}
      {msg && <p role="status" style={{ color: msg.ok ? 'var(--success)' : 'var(--danger)', fontSize: '0.9rem', marginBottom: 0 }}>{msg.text}</p>}
      <p style={{ ...s.muted, marginBottom: 0 }}>{`PDFs only, up to 10 per email, about ${EMAIL_TOTAL_MB} MB total per email (bigger emails can't be received).`} Keep this address private; tap New address if it gets shared.</p>
    </section>
  );
}
