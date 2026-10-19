'use client';
// Owner-only "Invite a tester" page. The server re-checks ownership on every call; this page just hides the form.
import { useCallback, useEffect, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import { makeApi } from '../../lib/packetApi';
import { ROLE_LABELS } from '../../lib/companyRoles';
import { useHydrated, fallbackAction } from '../../lib/authForms';
import { formatSentAt } from '../../lib/packetDate';
import { existingHint } from '../../lib/testerInvites';
import { EDITABLE_ROLES, ROLE_HELP, roleEditable, confirmText, successText } from '../../lib/memberRoles';

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
  const hydrated = useHydrated();
  const [msg, setMsg] = useState(null); // { ok, text }
  const [confirmCancel, setConfirmCancel] = useState(null); // row id awaiting "Yes, cancel"
  const [roleEdit, setRoleEdit] = useState(null); // { id, role, confirm } while changing a member's role
  const [roleMsg, setRoleMsg] = useState(null); // { ok, text } for the Team list

  const load = useCallback(async () => {
    if (supabaseConfigError) return setSt({ error: supabaseConfigError });
    const d = await api('/api/account/invites');
    // A failed refresh after an action keeps the list on screen (only the first load shows a full-page error).
    if (d.error) return setSt((prev) => (prev.invites && !d.signedOut ? { ...prev, refreshError: 'Couldn’t refresh the list. Reload the page to see the latest.' } : { error: d.error, signedOut: d.signedOut, notOwner: d.status === 403 }));
    setSt(d); setF((x) => ({ ...x, role: x.role || d.defaultRole })); // fresh data clears any refreshError
  }, []);
  useEffect(() => { load(); }, [load]);

  async function send(e) {
    e.preventDefault(); if (busy) return;
    setBusy('invite'); setMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ email: f.email, name: f.name, role: f.role }) });
    setBusy(null);
    if (r.error) return setMsg({ ok: false, text: r.error });
    setMsg(r.warning ? { warn: true, text: r.warning } : { ok: true, text: `Invite sent to ${r.email}. They’ll get an email to set their password.` });
    setF((x) => ({ ...x, email: '', name: '' })); load();
  }
  async function again(email) {
    if (busy) return;
    setBusy(email); setMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'resend', email }) });
    setBusy(null);
    setMsg(r.error ? { ok: false, text: r.error } : r.warning ? { warn: true, text: r.warning } : { ok: true, text: r.message || `Invite resent to ${email}.` });
    load();
  }

  async function cancel(x) {
    if (busy) return;
    setBusy(`cancel:${x.id}`); setMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'cancel', email: x.email, id: x.id }) });
    setBusy(null); setConfirmCancel(null);
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: `Invite to ${r.cancelled} cancelled.` });
    load();
  }

  async function saveRole(x) {
    if (busy || !roleEdit) return;
    setBusy(`role:${x.id}`); setRoleMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'role', user_id: x.id, role: roleEdit.role }) });
    setBusy(null);
    if (r.error) { setRoleEdit((e) => (e ? { ...e, confirm: false } : e)); return setRoleMsg({ ok: false, text: r.error }); }
    setRoleEdit(null); setRoleMsg({ ok: true, text: successText(x.name || x.email, r.role) });
    load();
  }

  if (st.loading) return <main style={s.main}><p>Loading…</p></main>;
  if (st.error) return <main style={s.main}><h1>Invite a tester</h1><p role="alert" style={{ color: '#b91c1c' }}>{st.error}</p>{st.signedOut && <a href="/login?next=/account/invite">Sign in</a>}</main>;
  const list = st.invites || [];
  const hint = existingHint(list, f.email);
  return (
    <main style={s.main}>
      <h1 style={{ marginBottom: '0.25rem' }}>Invite a tester</h1>
      <p style={{ ...s.muted, marginTop: 0 }}>They get an email to set a password, then join {st.company || 'your company'}.{st.limit ? ` ${Math.max(0, st.limit.hourly - st.limit.used)} of ${st.limit.hourly} invites left this hour.` : ''}</p>
      <form method="post" action={fallbackAction('/account/invite')} onSubmit={send} noValidate data-auth-form="invite" style={s.card} data-testid="invite-form">
        <label htmlFor="inv-email" style={{ ...s.label, marginTop: 0 }}>Email</label>
        <input id="inv-email" style={s.input} type="email" inputMode="email" autoComplete="off" required value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); if (msg && !msg.ok && !msg.warn) setMsg(null); }} placeholder="name@example.com" />
        {hint && <p role="status" data-testid="invite-existing-hint" style={{ fontSize: 13, color: '#92400e', background: '#fffbeb', borderRadius: 8, padding: '0.45rem 0.6rem', margin: '0.4rem 0 0' }}>{hint.text}</p>}
        <label htmlFor="inv-name" style={s.label}>Name (optional)</label>
        <input id="inv-name" style={s.input} maxLength={80} autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label htmlFor="inv-role" style={s.label}>Access</label>
        <select id="inv-role" style={s.input} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {(st.roles || []).map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
        </select>
        <p style={{ ...s.muted, fontSize: 13, margin: '0.35rem 0 0' }}>Driver: view and upload. Dispatcher / Management: can also edit packets and the company profile.</p>
        <button type="submit" style={{ ...s.btn, opacity: !hydrated || busy ? 0.6 : 1 }} disabled={!hydrated || !!busy}>{busy === 'invite' ? 'Sending…' : 'Send invite'}</button>
        {msg && <p role={msg.ok ? 'status' : 'alert'} data-testid="invite-msg" data-kind={msg.ok ? 'ok' : msg.warn ? 'warn' : 'error'} style={{ fontSize: 14, color: msg.ok ? '#065f46' : msg.warn ? '#92400e' : '#b91c1c', margin: '0.6rem 0 0' }}>{msg.text}</p>}
      </form>
      <section style={s.card}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Team and invites</h2>
        <p style={{ ...s.muted, fontSize: 13, margin: '0.25rem 0 0' }}>Tap Change role to switch a member between Driver, Dispatcher and Management. Your own (owner) role can’t be changed here.</p>
        {roleMsg && <p role={roleMsg.ok ? 'status' : 'alert'} data-testid="role-msg" data-kind={roleMsg.ok ? 'ok' : 'error'} style={{ fontSize: 14, borderRadius: 8, padding: '0.5rem 0.65rem', margin: '0.6rem 0 0', color: roleMsg.ok ? '#065f46' : '#b91c1c', background: roleMsg.ok ? '#ecfdf5' : '#fef2f2' }}>{roleMsg.text}</p>}
        {st.refreshError && <p role="alert" data-testid="invite-refresh-error" style={{ ...s.muted, color: '#92400e' }}>{st.refreshError}</p>}
        {!list.length ? <p style={s.muted}>No one yet.</p> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
            {list.map((x) => (
              <li key={x.id} data-testid="invite-row" style={{ padding: '0.6rem 0', borderTop: '1px solid #f1f5f9' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name ? `${x.name} · ` : ''}{x.email}</div>
                  <div style={s.muted}><span style={badge(x.status)}>{x.status === 'pending' ? 'Pending' : 'Accepted'}</span> {ROLE_LABELS[x.role] || ''}{x.invited_at ? ` · invited ${formatSentAt(x.invited_at)}` : ''}{!x.linked ? ' · not linked yet' : ''}</div>
                </div>
                <div data-testid="invite-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
                {confirmCancel !== x.id && (x.status === 'pending' || !x.linked) && <button type="button" style={s.small} disabled={!!busy} onClick={() => again(x.email)}>{busy === x.email ? 'Sending…' : x.status === 'pending' ? 'Resend' : 'Link'}</button>}
                {x.status === 'pending' && (confirmCancel === x.id
                  ? <span data-testid="cancel-confirm" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ fontSize: 13 }}>Cancel this invite?</span>
                      <button type="button" style={{ ...s.small, borderColor: '#b91c1c', color: '#b91c1c' }} disabled={!!busy} onClick={() => cancel(x)}>{busy === `cancel:${x.id}` ? 'Cancelling…' : 'Yes, cancel'}</button>
                      <button type="button" style={s.small} disabled={!!busy} onClick={() => setConfirmCancel(null)}>Keep</button></span>
                  : <button type="button" data-testid="invite-cancel" style={s.small} disabled={!!busy} onClick={() => setConfirmCancel(x.id)}>Cancel</button>)}
                {confirmCancel !== x.id && roleEditable(x, st.ownerId) && roleEdit?.id !== x.id && <button type="button" data-testid="role-edit" style={s.small} disabled={!!busy} onClick={() => { setRoleEdit({ id: x.id, role: x.role, confirm: false }); setRoleMsg(null); }}>Change role</button>}
                </div>
                </div>
                {roleEdit?.id === x.id && (
                  <div data-testid="role-editor" style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: '0.75rem', marginTop: '0.5rem' }}>
                    {!roleEdit.confirm ? (<>
                      <label htmlFor={`role-${x.id}`} style={{ ...s.label, marginTop: 0 }}>Role for {x.name || x.email}</label>
                      <select id={`role-${x.id}`} data-testid="role-select" style={s.input} value={roleEdit.role} disabled={!!busy} onChange={(e) => setRoleEdit({ ...roleEdit, role: e.target.value })}>
                        {EDITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}{r === x.role ? ' (current)' : ''}</option>)}
                      </select>
                      <p style={{ ...s.muted, fontSize: 13, margin: '0.35rem 0 0' }}>{ROLE_HELP[roleEdit.role]}</p>
                      <div style={{ display: 'flex', gap: 8, marginTop: '0.6rem' }}>
                        <button type="button" data-testid="role-save" style={{ ...s.small, background: '#2563eb', borderColor: '#2563eb', color: '#fff', opacity: roleEdit.role === x.role ? 0.5 : 1 }} disabled={!!busy || roleEdit.role === x.role} onClick={() => setRoleEdit({ ...roleEdit, confirm: true })}>Save role</button>
                        <button type="button" style={s.small} disabled={!!busy} onClick={() => setRoleEdit(null)}>Cancel</button>
                      </div>
                    </>) : (
                      <div data-testid="role-confirm" role="alertdialog" aria-label="Confirm role change">
                        <p style={{ margin: '0 0 0.6rem', fontSize: 14 }}>{confirmText(x.name || x.email, x.role, roleEdit.role)}</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="button" data-testid="role-confirm-yes" style={{ ...s.small, background: '#2563eb', borderColor: '#2563eb', color: '#fff' }} disabled={!!busy} onClick={() => saveRole(x)}>{busy === `role:${x.id}` ? 'Saving…' : 'Yes, change role'}</button>
                          <button type="button" style={s.small} disabled={!!busy} onClick={() => setRoleEdit({ ...roleEdit, confirm: false })}>Back</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
