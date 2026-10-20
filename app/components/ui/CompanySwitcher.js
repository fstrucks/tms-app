'use client';
// Account menu: "Company" picker, shown only to users in more than one company. Saves the choice server-side
// (validated against company_members) and reloads so every page uses it.
import { useEffect, useState } from 'react';
import { fetchActiveCompany, setActiveCompany } from '../../lib/activeCompanyClient';
import { ACTIVE_EVENT } from '../../lib/activeCompany';
import { ROLE_LABELS } from '../../lib/companyRoles';

export default function CompanySwitcher({ uid }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Load as soon as the session is known (not on menu open), keep the last good answer while refreshing, and
  // refresh on Join / switch (ACTIVE_EVENT).
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setTick((n) => n + 1); window.addEventListener(ACTIVE_EVENT, f); return () => window.removeEventListener(ACTIVE_EVENT, f); }, []);
  useEffect(() => { if (!uid) { setSt(null); return undefined; } let live = true; fetchActiveCompany().then((d) => { if (live && !d.error) setSt(d); }); return () => { live = false; }; }, [uid, tick]);
  if (!st?.multi) return null;
  async function pick(id) {
    if (busy || id === st.active?.profile_id) return;
    setBusy(true); setErr(null);
    const r = await setActiveCompany(id);
    if (r.error) { setBusy(false); return setErr(r.error); }
    window.location.reload();
  }
  return (
    <div role="group" aria-label="Company" data-testid="company-switcher" style={{ padding: '0.35rem 0.8rem 0.5rem', borderBottom: '1px solid var(--divider)' }}>
      <div aria-hidden="true" style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 6 }}>Company</div>
      {st.companies.map((c) => (
        <button key={c.profile_id} type="button" role="menuitemradio" aria-checked={st.active?.profile_id === c.profile_id} disabled={busy}
          data-testid="company-switch" onClick={() => pick(c.profile_id)}
          style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '0.4rem 0.6rem', marginBottom: 4, fontSize: 15, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)',
            background: st.active?.profile_id === c.profile_id ? 'var(--primary)' : 'var(--surface)', color: st.active?.profile_id === c.profile_id ? 'var(--on-primary)' : 'var(--text)' }}>
          {c.name} <span style={{ fontSize: 13, opacity: 0.85 }}>· {ROLE_LABELS[c.role] || c.role}</span>
        </button>
      ))}
      {err && <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: '0.25rem 0 0' }}>{err}</p>}
    </div>
  );
}
