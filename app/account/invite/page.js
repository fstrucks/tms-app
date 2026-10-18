'use client';
// Owner-only "Invite a tester" page. The server re-checks ownership on every call; this page just hides the form.
import { useCallback, useEffect, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import { makeApi } from '../../lib/packetApi';
import { ROLE_LABELS } from '../../lib/companyRoles';
import { formatSentAt } from '../../lib/packetDate';

const api = makeApi(() => getSupabase()?.auth).call;
const s = {
  main: { padding: '1rem', fontFamily: 'system-ui', maxWidth: 560, margin: '0 auto' },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  label: { display: 'block', margin: '0.75rem 0 0.35rem', fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0 0.75rem', fontSize: 16, borderRadius: 8, border: '1px solid #d1d5db' },
  btn: { width: '100%', minHeight: 48, fontSize: '1rem', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', marginTop: '0.9rem', cursor: 'pointer', fontWeight: 600 },
  small: { minHeight: 40, padding: '0 0.8rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, cursor: 'pointer' },
  muted: { color: '#6b7280', fontSize: 14 },
};
const badge = (st) => ({ display: 'inline-block', padding: '0.1rem 0.55rem', borderRadius: 999, fontSize: 13, fontWeight: 600, background: st === 'pending' ? '#fef3c7' : '#dcfce7', color: st === 'pending' ? '#92400e' : '#166534' });

export default function InviteTesterPage() {
  const [st, setSt] = useState({ loading: true });
  const [f, setF] = useState({ email: '', name: '', role: '' });
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    if (supabaseConfigError) return setSt({ error: supabaseConfigError });
    const d = await api('/api/account/invites');
    if (d.error) return setSt({ error: d.error, signedOut: d.signedOut, notOwner: d.status === 403 });
    setSt(d); setF((x) => ({ ...x, role: x.role || d.defaultRole }));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function send(e) {
    e.preventDefault(); if (busy) return;
    setBusy('invite'); setMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ email: f.email, name: f.name, role: f.role }) });
    setBusy(null);
    if (r.error) return setMsg({ ok: false, text: r.error });
    setMsg({ ok: true, text: r.warning || `Invite sent to ${r.email}. They’ll get an email to set their password.` });
    setF((x) => ({ ...x, email: '', name: '' })); load();
  }
  async function again(email) {
    if (busy) return;
    setBusy(email); setMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'resend', email }) });
    setBusy(null);
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.warning || r.message || `Invite resent to ${email}.` });
    load();
  }

  if (st.loading) return <main style={s.main}><p>Loading…</p></main>;
  if (st.error) return <main style={s.main}><h1>Invite a tester</h1><p role="alert" style={{ color: '#b91c1c' }}>{st.error}</p>{st.signedOut && <a href="/login?next=/account/invite">Sign in</a>}</main>;
  const list = st.invites || [];
  return (
    <main style={s.main}>
      <h1 style={{ marginBottom: '0.25rem' }}>Invite a tester</h1>
      <p style={{ ...s.muted, marginTop: 0 }}>They get an email to set a password, then join {st.company || 'your company'}.{st.limit ? ` ${Math.max(0, st.limit.hourly - st.limit.used)} of ${st.limit.hourly} invites left this hour.` : ''}</p>
      <form onSubmit={send} noValidate style={s.card} data-testid="invite-form">
        <label htmlFor="inv-email" style={{ ...s.label, marginTop: 0 }}>Email</label>
        <input id="inv-email" style={s.input} type="email" inputMode="email" autoComplete="off" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@example.com" />
        <label htmlFor="inv-name" style={s.label}>Name (optional)</label>
        <input id="inv-name" style={s.input} maxLength={80} autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label htmlFor="inv-role" style={s.label}>Access</label>
        <select id="inv-role" style={s.input} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {(st.roles || []).map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
        </select>
        <p style={{ ...s.muted, fontSize: 13, margin: '0.35rem 0 0' }}>Driver: view and upload. Dispatcher / Management: can also edit packets and the company profile.</p>
        <button type="submit" style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={!!busy}>{busy === 'invite' ? 'Sending…' : 'Send invite'}</button>
        {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ fontSize: 14, color: msg.ok ? '#065f46' : '#b91c1c', margin: '0.6rem 0 0' }}>{msg.text}</p>}
      </form>
      <section style={s.card}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Invited</h2>
        {!list.length ? <p style={s.muted}>No one yet.</p> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
            {list.map((x) => (
              <li key={x.id} data-testid="invite-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.6rem 0', borderTop: '1px solid #f1f5f9' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name ? `${x.name} · ` : ''}{x.email}</div>
                  <div style={s.muted}><span style={badge(x.status)}>{x.status === 'pending' ? 'Pending' : 'Accepted'}</span> {ROLE_LABELS[x.role] || ''}{x.invited_at ? ` · invited ${formatSentAt(x.invited_at)}` : ''}{!x.linked ? ' · not linked yet' : ''}</div>
                </div>
                {(x.status === 'pending' || !x.linked) && <button type="button" style={s.small} disabled={!!busy} onClick={() => again(x.email)}>{busy === x.email ? 'Sending…' : x.status === 'pending' ? 'Resend' : 'Link'}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
