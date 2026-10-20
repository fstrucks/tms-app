'use client';
// "Join <company>?" card for a signed-in user an owner added while they were already in another company.
// Accepting adds a membership; nothing about their other company changes. See app/lib/companyAdds.js.
import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { ROLE_LABELS } from '../lib/companyRoles';

const api = makeApi(() => getSupabase()?.auth).call;
const btn = { minHeight: 44, padding: '0 1rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 15, fontWeight: 600, cursor: 'pointer' };

export default function CompanyAddPrompt() {
  const [uid, setUid] = useState(null);
  const [adds, setAdds] = useState([]);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    const sb = getSupabase(); if (!sb) return undefined;
    sb.auth.getSession().then(({ data }) => setUid(data?.session?.user?.id || null)).catch(() => {});
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setUid(s?.user?.id || null));
    return () => sub?.subscription?.unsubscribe?.();
  }, []);
  useEffect(() => {
    if (!uid) { setAdds([]); return; }
    let live = true;
    api('/api/account/company-adds').then((d) => { if (live && !d.error && Array.isArray(d.adds)) setAdds(d.adds); });
    return () => { live = false; };
  }, [uid]);
  async function answer(a, accept) {
    setBusy(a.company); setMsg(null);
    const r = await api('/api/account/company-adds', { method: 'POST', body: JSON.stringify({ company: a.company, accept }) });
    setBusy(null);
    if (r.error) return setMsg({ ok: false, text: r.error });
    setAdds((xs) => xs.filter((x) => x.company !== a.company));
    setMsg({ ok: true, text: accept ? `You joined ${a.company_name} as ${ROLE_LABELS[a.role] || a.role}. Reload to see their loads.` : `Declined. You weren’t added to ${a.company_name}.` });
  }
  if (!adds.length && !msg) return null;
  return (
    <div data-testid="company-add-prompt" style={{ maxWidth: 560, margin: '0.75rem auto 0', padding: '0 1rem', fontFamily: 'system-ui' }}>
      {adds.slice(0, 1).map((a) => (
        <div key={a.company} role="region" aria-label="Company add" style={{ border: '1px solid var(--warning)', background: 'var(--warning-bg)', borderRadius: 12, padding: '0.85rem' }}>
          <p style={{ margin: '0 0 0.6rem' }}><strong>Join {a.company_name}?</strong> The owner added you as {ROLE_LABELS[a.role] || a.role}. You’ll stay in your current company too.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" data-testid="company-add-accept" style={{ ...btn, background: 'var(--primary)', borderColor: 'var(--primary)', color: 'var(--on-primary)' }} disabled={!!busy} onClick={() => answer(a, true)}>{busy === a.company ? 'Saving…' : 'Join'}</button>
            <button type="button" data-testid="company-add-decline" style={btn} disabled={!!busy} onClick={() => answer(a, false)}>Decline</button>
          </div>
        </div>
      ))}
      {msg && <p role={msg.ok ? 'status' : 'alert'} data-testid="company-add-msg" style={{ fontSize: 14, margin: '0.5rem 0 0', color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</p>}
    </div>
  );
}
