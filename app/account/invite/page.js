'use client';
// Owner-only "Invite a tester" page. The server re-checks ownership on every call; this page just hides the form.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, supabaseConfigError } from '../../lib/supabase';
import { makeApi } from '../../lib/packetApi';
import { ROLE_LABELS } from '../../lib/companyRoles';
import { useHydrated, fallbackAction } from '../../lib/authForms';
import { formatSentAt } from '../../lib/packetDate';
import { existingHint } from '../../lib/testerInvites';
import { EDITABLE_ROLES, ROLE_HELP, roleEditable, confirmText, successText, unassignsLoads, unassignWarning, applyRoleResult, alsoDrivesEditable, ALSO_DRIVES_ROLES, ALSO_DRIVES_HELP, alsoDrivesText, applyAlsoDrives } from '../../lib/memberRoles';
import LegalFooter from '../../components/LegalFooter';

const api = makeApi(() => getSupabase()?.auth).call;
const s = {
  main: { padding: '1rem', paddingBottom: 'calc(1rem + var(--fab-space))', fontFamily: 'system-ui', maxWidth: 560, margin: '0 auto' }, // room under the Team list for the Report a bug button (QA #97)
  card: { border: '1px solid var(--divider)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' },
  label: { display: 'block', margin: '0.75rem 0 0.35rem', fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0 0.75rem', fontSize: 16, borderRadius: 8, border: '1px solid var(--border)' },
  btn: { width: '100%', minHeight: 48, fontSize: '1rem', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'var(--on-primary)', marginTop: '0.9rem', cursor: 'pointer', fontWeight: 600 },
  small: { minHeight: 40, padding: '0 0.8rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 14, cursor: 'pointer' },
  muted: { color: 'var(--text-muted)', fontSize: 14 },
};
const badge = (st) => ({ display: 'inline-block', padding: '0.1rem 0.55rem', borderRadius: 999, fontSize: 13, fontWeight: 600, background: st === 'pending' ? 'var(--warning-bg)' : 'var(--success-bg)', color: st === 'pending' ? 'var(--warning)' : 'var(--success)' });

export default function InviteTesterPage() {
  const [st, setSt] = useState({ loading: true });
  const [f, setF] = useState({ email: '', name: '', role: '' });
  const [busy, setBusy] = useState(null);
  const hydrated = useHydrated();
  const [msg, setMsg] = useState(null); // { ok, text }
  const [confirmCancel, setConfirmCancel] = useState(null); // row id awaiting "Yes, cancel"
  const [roleEdit, setRoleEdit] = useState(null); // { id, role, confirm } while changing a member's role
  const [roleMsg, setRoleMsg] = useState(null); // { ok, text } for the Team list
  // QA #97 (390px): when the confirmation opens, scroll it so Yes / Back sit above the tab bar and the floating
  // Report a bug button ([data-above-fab] scroll margin in globals.css), and move focus to it.
  const confirmRef = useRef(null);
  useEffect(() => {
    if (!roleEdit?.confirm || !confirmRef.current) return;
    const el = confirmRef.current;
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { el.scrollIntoView(false); }
    el.focus?.({ preventScroll: true });
  }, [roleEdit?.confirm, roleEdit?.id]);

  const load = useCallback(async ({ expectRole = null } = {}) => {
    if (supabaseConfigError) return setSt({ error: supabaseConfigError });
    const d = await api('/api/account/invites');
    // A reload that raced the save (started before it landed) must not put the old role back on the row.
    if (!d.error && expectRole && Array.isArray(d.invites)) d.invites = applyRoleResult(d.invites, expectRole.id, expectRole.role);
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
    setMsg(r.warning ? { warn: true, text: r.warning } : (r.added || r.pending) && r.message ? { ok: true, text: r.message } : { ok: true, text: `Invite sent to ${r.email}. They’ll get an email to set their password.` });
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
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: x.status === 'add_pending' ? `Add for ${r.cancelled} cancelled.` : `Invite to ${r.cancelled} cancelled.` });
    load();
  }

  // "Also drives" for the new role (only once 20261020000100 is applied; a Driver never carries it).
  const keepAlso = (e) => (st.alsoDrives && ALSO_DRIVES_ROLES.includes(e?.role) ? e.also === true : false);

  async function toggleAlso(x, on) {
    if (busy) return;
    if (!on && typeof window !== 'undefined' && !window.confirm(`Turn off Also drives for ${x.name || x.email}? They’ll be unassigned from any loads they drive.`)) return;
    setBusy(`also:${x.id}`); setRoleMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'also_drives', user_id: x.id, on }) });
    setBusy(null);
    if (r.error) return setRoleMsg({ ok: false, text: r.error });
    setSt((prev) => (prev.invites ? { ...prev, invites: applyAlsoDrives(prev.invites, x.id, r.also_drives) } : prev));
    setRoleMsg({ ok: true, text: alsoDrivesText(x.name || x.email, r.also_drives, r.unassigned) });
  }

  // Save role → (driver moving away: how many loads they'd be unassigned from) → confirmation.
  async function askRole(x) {
    if (busy || !roleEdit) return;
    setRoleMsg(null);
    if (!unassignsLoads(x.role, roleEdit.role, x.also_drives === true, keepAlso(roleEdit))) return setRoleEdit({ ...roleEdit, confirm: true, assigned: 0 });
    setBusy(`preview:${x.id}`);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'role_preview', user_id: x.id }) });
    setBusy(null);
    if (r.error && r.status === 403) return setRoleMsg({ ok: false, text: r.error });
    setRoleEdit((e) => (e ? { ...e, confirm: true, assigned: r.error ? null : r.assigned } : e)); // null = couldn't count: generic warning
  }

  async function saveRole(x) {
    if (busy || !roleEdit) return;
    setBusy(`role:${x.id}`); setRoleMsg(null);
    const r = await api('/api/account/invites', { method: 'POST', body: JSON.stringify({ action: 'role', user_id: x.id, role: roleEdit.role, ...(st.alsoDrives ? { also_drives: keepAlso(roleEdit) } : {}) }) });
    setBusy(null);
    if (r.error) { setRoleEdit((e) => (e ? { ...e, confirm: false } : e)); return setRoleMsg({ ok: false, text: r.error }); }
    // QA #97: show the new role on the row right away, from the role the server confirmed (the list reload follows).
    setSt((prev) => (prev.invites ? { ...prev, invites: applyRoleResult(prev.invites, x.id, r.role, r.also_drives) } : prev));
    setRoleEdit(null); setRoleMsg({ ok: true, text: successText(x.name || x.email, r.role, r.unassigned) });
    load({ expectRole: { id: x.id, role: r.role } });
  }

  if (st.loading) return <main style={s.main}><p>Loading…</p><LegalFooter /></main>;
  if (st.error) return <main style={s.main}><h1>Invite a tester</h1><p role="alert" style={{ color: 'var(--danger)' }}>{st.error}</p>{st.signedOut && <a href="/login?next=/account/invite">Sign in</a>}<LegalFooter /></main>;
  const list = st.invites || [];
  const hint = existingHint(list, f.email);
  return (
    <main style={s.main}>
      <h1 style={{ marginBottom: '0.25rem' }}>Invite a tester</h1>
      <p style={{ ...s.muted, marginTop: 0 }}>They get an email to set a password, then join {st.company || 'your company'}. Already on PowerHaul? Enter their email and they’re added instead (if they’re in another company, they accept first).{st.limit ? ` ${Math.max(0, st.limit.hourly - st.limit.used)} of ${st.limit.hourly} invites left this hour.` : ''}</p>
      <form method="post" action={fallbackAction('/account/invite')} onSubmit={send} noValidate data-auth-form="invite" style={s.card} data-testid="invite-form">
        <label htmlFor="inv-email" style={{ ...s.label, marginTop: 0 }}>Email</label>
        <input id="inv-email" style={s.input} type="email" inputMode="email" autoComplete="off" required value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); if (msg && !msg.ok && !msg.warn) setMsg(null); }} placeholder="name@example.com" />
        {hint && <p role="status" data-testid="invite-existing-hint" style={{ fontSize: 13, color: 'var(--warning)', background: 'var(--warning-bg)', borderRadius: 8, padding: '0.45rem 0.6rem', margin: '0.4rem 0 0' }}>{hint.text}</p>}
        <label htmlFor="inv-name" style={s.label}>Name (optional)</label>
        <input id="inv-name" style={s.input} maxLength={80} autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label htmlFor="inv-role" style={s.label}>Access</label>
        <select id="inv-role" style={s.input} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {(st.roles || []).map((r) => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
        </select>
        <p style={{ ...s.muted, fontSize: 13, margin: '0.35rem 0 0' }}>Driver: view and upload. Dispatcher / Management: can also edit packets and the company profile.</p>
        <button type="submit" style={{ ...s.btn, opacity: !hydrated || busy ? 0.6 : 1 }} disabled={!hydrated || !!busy}>{busy === 'invite' ? 'Sending…' : 'Send invite'}</button>
        {msg && <p role={msg.ok ? 'status' : 'alert'} data-testid="invite-msg" data-kind={msg.ok ? 'ok' : msg.warn ? 'warn' : 'error'} style={{ fontSize: 14, color: msg.ok ? 'var(--success)' : msg.warn ? 'var(--warning)' : 'var(--danger)', margin: '0.6rem 0 0' }}>{msg.text}</p>}
      </form>
      <section style={s.card}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Team and invites</h2>
        <p style={{ ...s.muted, fontSize: 13, margin: '0.25rem 0 0' }}>Tap Change role to switch a member between Driver, Dispatcher and Management. Your own (owner) role can’t be changed here.</p>
        {roleMsg && <p role={roleMsg.ok ? 'status' : 'alert'} data-testid="role-msg" data-kind={roleMsg.ok ? 'ok' : 'error'} style={{ fontSize: 14, borderRadius: 8, padding: '0.5rem 0.65rem', margin: '0.6rem 0 0', color: roleMsg.ok ? 'var(--success)' : 'var(--danger)', background: roleMsg.ok ? 'var(--success-bg)' : 'var(--danger-bg)' }}>{roleMsg.text}</p>}
        {st.refreshError && <p role="alert" data-testid="invite-refresh-error" style={{ ...s.muted, color: 'var(--warning)' }}>{st.refreshError}</p>}
        {!list.length ? <p style={s.muted}>No one yet.</p> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
            {list.map((x) => (
              <li key={x.id} data-testid="invite-row" style={{ padding: '0.6rem 0', borderTop: '1px solid var(--divider)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name ? `${x.name} · ` : ''}{x.email}</div>
                  <div style={s.muted}><span style={badge(x.status === 'add_pending' ? 'pending' : x.status)}>{x.status === 'pending' ? 'Pending' : x.status === 'add_pending' ? 'Waiting to accept' : 'Accepted'}</span> {ROLE_LABELS[x.role] || ''}{x.also_drives ? ' + Driver' : ''}{x.added_at ? ` · added ${formatSentAt(x.added_at)}` : x.invited_at ? ` · invited ${formatSentAt(x.invited_at)}` : ''}{!x.linked ? ' · not linked yet' : ''}</div>
                </div>
                <div data-testid="invite-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
                {confirmCancel !== x.id && x.status !== 'add_pending' && (x.status === 'pending' || !x.linked) && <button type="button" style={s.small} disabled={!!busy} onClick={() => again(x.email)}>{busy === x.email ? 'Sending…' : x.status === 'pending' ? 'Resend' : 'Link'}</button>}
                {(x.status === 'pending' || x.status === 'add_pending') && (confirmCancel === x.id
                  ? <span data-testid="cancel-confirm" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ fontSize: 13 }}>{x.status === 'add_pending' ? 'Cancel this add?' : 'Cancel this invite?'}</span>
                      <button type="button" style={{ ...s.small, borderColor: 'var(--danger)', color: 'var(--danger)' }} disabled={!!busy} onClick={() => cancel(x)}>{busy === `cancel:${x.id}` ? 'Cancelling…' : 'Yes, cancel'}</button>
                      <button type="button" style={s.small} disabled={!!busy} onClick={() => setConfirmCancel(null)}>Keep</button></span>
                  : <button type="button" data-testid="invite-cancel" style={s.small} disabled={!!busy} onClick={() => setConfirmCancel(x.id)}>Cancel</button>)}
                {confirmCancel !== x.id && roleEditable(x, st.ownerId) && roleEdit?.id !== x.id && <button type="button" data-testid="role-edit" style={s.small} disabled={!!busy} onClick={() => { setRoleEdit({ id: x.id, role: x.role, also: x.also_drives === true, confirm: false }); setRoleMsg(null); }}>Change role</button>}
                {st.alsoDrives && confirmCancel !== x.id && alsoDrivesEditable(x, st.ownerId) && roleEdit?.id !== x.id && (
                  <label data-testid="also-drives" title={ALSO_DRIVES_HELP} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: 14 }}>
                    <input type="checkbox" data-testid="also-drives-toggle" checked={x.also_drives === true} disabled={!!busy} onChange={(e) => toggleAlso(x, e.target.checked)} style={{ width: 22, height: 22 }} />
                    {busy === `also:${x.id}` ? 'Saving…' : 'Also drives'}
                  </label>)}
                </div>
                </div>
                {roleEdit?.id === x.id && (
                  <div data-testid="role-editor" data-ui-busy style={{ background: 'var(--surface-2)', border: '1px solid var(--divider)', borderRadius: 10, padding: '0.75rem', marginTop: '0.5rem' }}>
                    {!roleEdit.confirm ? (<>
                      <label htmlFor={`role-${x.id}`} style={{ ...s.label, marginTop: 0 }}>Role for {x.name || x.email}</label>
                      <select id={`role-${x.id}`} data-testid="role-select" style={s.input} value={roleEdit.role} disabled={!!busy} onChange={(e) => setRoleEdit({ ...roleEdit, role: e.target.value })}>
                        {EDITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}{r === x.role ? ' (current)' : ''}</option>)}
                      </select>
                      <p style={{ ...s.muted, fontSize: 13, margin: '0.35rem 0 0' }}>{ROLE_HELP[roleEdit.role]}</p>
                      {st.alsoDrives && ALSO_DRIVES_ROLES.includes(roleEdit.role) && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, fontSize: 14 }}>
                          <input type="checkbox" data-testid="role-also-drives" checked={roleEdit.also === true} disabled={!!busy} onChange={(e) => setRoleEdit({ ...roleEdit, also: e.target.checked })} style={{ width: 22, height: 22 }} />
                          Also drives{x.role === 'driver' ? ' (keeps their loads)' : ''}
                        </label>)}
                      <div style={{ display: 'flex', gap: 8, marginTop: '0.6rem' }}>
                        <button type="button" data-testid="role-save" style={{ ...s.small, background: 'var(--primary)', borderColor: 'var(--primary)', color: 'var(--on-primary)', opacity: roleEdit.role === x.role ? 0.5 : 1 }} disabled={!!busy || roleEdit.role === x.role} onClick={() => askRole(x)}>{busy === `preview:${x.id}` ? 'Checking loads…' : 'Save role'}</button>
                        <button type="button" style={s.small} disabled={!!busy} onClick={() => setRoleEdit(null)}>Cancel</button>
                      </div>
                    </>) : (
                      <div ref={confirmRef} tabIndex={-1} data-above-fab data-testid="role-confirm" role="alertdialog" aria-label="Confirm role change" style={{ outline: 'none' }}>
                        <p style={{ margin: '0 0 0.6rem', fontSize: 14 }}>{confirmText(x.name || x.email, x.role, roleEdit.role)}</p>
                        {unassignsLoads(x.role, roleEdit.role, x.also_drives === true, keepAlso(roleEdit)) && (roleEdit.assigned == null || roleEdit.assigned > 0) && (
                          <p data-testid="role-unassign-warning" style={{ margin: '0 0 0.6rem', fontSize: 14, color: 'var(--warning)', background: 'var(--warning-bg)', borderRadius: 8, padding: '0.45rem 0.6rem' }}>
                            {roleEdit.assigned == null ? `If ${x.name || x.email} is assigned to loads, changing their role unassigns them.` : unassignWarning(x.name || x.email, roleEdit.assigned)}
                          </p>
                        )}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button type="button" data-testid="role-confirm-yes" style={{ ...s.small, background: 'var(--primary)', borderColor: 'var(--primary)', color: 'var(--on-primary)' }} disabled={!!busy} onClick={() => saveRole(x)}>{busy === `role:${x.id}` ? 'Saving…' : 'Yes, change role'}</button>
                          <button type="button" data-testid="role-confirm-back" style={s.small} disabled={!!busy} onClick={() => setRoleEdit({ ...roleEdit, confirm: false })}>Back</button>
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
      <LegalFooter />
    </main>
  );
}
