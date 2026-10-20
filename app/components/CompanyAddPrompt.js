'use client';
// "Join <company>?" card for a signed-in user an owner added while they were already in another company.
// Accepting adds a membership; nothing about their other company changes. See app/lib/companyAdds.js.
import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { ROLE_LABELS } from '../lib/companyRoles';
import { fetchActiveCompany, setActiveCompany } from '../lib/activeCompanyClient';
import { joinedText } from '../lib/companyAdds';

const api = makeApi(() => getSupabase()?.auth).call;
const btn = { minHeight: 44, padding: '0 1rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 15, fontWeight: 600, cursor: 'pointer' };

export default function CompanyAddPrompt() {
  const [uid, setUid] = useState(null);
  const [adds, setAdds] = useState([]);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    const sb = getSupabase(); if (!sb) return undefined;
    document.body.dataset.pendingAddCheck = '1'; // hold the welcome sheet until we know (cleared below / after 8 s)
    const safety = setTimeout(() => { delete document.body.dataset.pendingAddCheck; }, 8000);
    sb.auth.getSession().then(({ data }) => { const id = data?.session?.user?.id || null; setUid(id); if (!id) delete document.body.dataset.pendingAddCheck; })
      .catch(() => { delete document.body.dataset.pendingAddCheck; });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setUid(s?.user?.id || null));
    return () => { clearTimeout(safety); sub?.subscription?.unsubscribe?.(); };
  }, []);
  useEffect(() => {
    if (!uid) { setAdds([]); delete document.body.dataset.pendingAddCheck; return undefined; }
    let live = true;
    // QA #103 (d): the first-sign-in welcome sheet waits while this check runs and while a Join card is showing
    // (body[data-pending-add-check] / body[data-pending-add] are in lib/welcome BUSY_UI_SELECTOR).
    document.body.dataset.pendingAddCheck = '1';
    api('/api/account/company-adds').then((d) => { if (live && !d.error && Array.isArray(d.adds)) setAdds(d.adds); })
      .finally(() => { delete document.body.dataset.pendingAddCheck; });
    return () => { live = false; delete document.body.dataset.pendingAddCheck; };
  }, [uid]);
  useEffect(() => {
    if (adds.length) document.body.dataset.pendingAdd = '1'; else delete document.body.dataset.pendingAdd;
    return () => { delete document.body.dataset.pendingAdd; };
  }, [adds.length]);
  async function answer(a, accept) {
    setBusy(a.company); setMsg(null);
    const r = await api('/api/account/company-adds', { method: 'POST', body: JSON.stringify({ company: a.company, accept }) });
    setBusy(null);
    if (r.error) return setMsg({ ok: false, text: r.error });
    setAdds((xs) => xs.filter((x) => x.company !== a.company));
    if (!accept) return setMsg({ ok: true, text: `Declined. You weren’t added to ${a.company_name}.` });
    const ac = await fetchActiveCompany({ fresh: true });
    setMsg({ ok: true, text: joinedText(a, ac), switchTo: ac.active?.profile_id === a.company ? null : a.company });
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
      {msg?.switchTo && <button type="button" data-testid="company-add-switch" style={{ ...btn, marginTop: 8 }} disabled={!!busy}
        onClick={async () => { setBusy('switch'); const r = await setActiveCompany(msg.switchTo); if (r.error) { setBusy(null); return setMsg({ ok: false, text: r.error }); } window.location.reload(); }}>{busy === 'switch' ? 'Switching…' : 'Switch now'}</button>}
    </div>
  );
}
