'use client';
// Browser side of the active company (see activeCompany.js). One fetch per page load, shared by every caller.
import { getSupabase } from './supabase';
import { makeApi } from './packetApi';
import { ACTIVE_EVENT } from './activeCompany';

const api = makeApi(() => getSupabase()?.auth).call;
let cache = null;
// → { companies, active, multi } ; on error { companies: [], active: null, multi: false, error }
export function fetchActiveCompany({ fresh = false } = {}) {
  if (!cache || fresh) {
    const p = api('/api/account/active-company').then((d) => (d.error ? { companies: [], active: null, multi: false, error: d.error } : { ...d, multi: (d.companies || []).length > 1 }))
      .catch(() => ({ companies: [], active: null, multi: false, error: 'network' }));
    cache = p;
    p.then((d) => { if (d.error && cache === p) cache = null; }); // never keep a failed answer (QA #103 re-test b)
  }
  return cache;
}
export async function setActiveCompany(profileId) {
  const r = await api('/api/account/active-company', { method: 'POST', body: JSON.stringify({ profile_id: profileId }) });
  if (!r.error) { cache = null; try { window.dispatchEvent(new Event(ACTIVE_EVENT)); } catch { /* ignore */ } }
  return r;
}
export const clearActiveCache = () => { cache = null; };
// After Join: refetch and tell the account menu right away.
export function refreshActiveCompany() { cache = null; try { window.dispatchEvent(new Event(ACTIVE_EVENT)); } catch { /* ignore */ } return fetchActiveCompany(); }
// Dispatch pages: the dispatch_context row for the active company, else the first one (single-company users).
export async function activeDispatchCompany(companies) {
  const list = companies || [];
  if (list.length < 2) return list[0];
  const ac = await fetchActiveCompany();
  return (ac.multi && list.find((x) => x.owner_id === ac.active?.owner_id)) || list[0];
}
