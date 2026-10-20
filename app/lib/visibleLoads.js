// PR #110 (QA b): loads RLS is own-row (user_id = auth.uid()), so a driver, dispatcher or Management member gets
// 0 rows from a direct `from('loads')` select. Members read loads only through public.visible_loads()
// (SECURITY DEFINER, migration 20261018000600): owner rows in full; members get an allow-list with rate only
// when allowed, and plain drivers only their assigned loads. /loads, /loads/[id] and the Documents scanner use it now.
import { isMissingFunction } from './homeCurrentLoad.js';

const unwrap = (rows) => (rows || []).map((r) => (r && r.visible_loads) || r).filter(Boolean);

// A user who owns a company and is also a member elsewhere: /loads shows his own company (other companies go
// through the account-menu company switch). A member-only user sees the company he belongs to.
export function ownCompanyFirst(rows) {
  const list = rows || [];
  return list.some((l) => l.viewer_role === 'owner') ? list.filter((l) => l.viewer_role === 'owner') : list;
}

// "Also drives" Management / Dispatcher: same company-wide list as before (they see all loads). Plain drivers
// already get only their assigned loads from the database.

// → { data: loads[], error, viaRpc }. Falls back to the old direct select only when the function is missing.
export async function fetchVisibleLoads(supabase, { fallbackCols = '*, stops(*)' } = {}) {
  const rpc = await supabase.rpc('visible_loads', { p_statuses: null, p_load: null });
  if (!rpc.error) return { data: ownCompanyFirst(unwrap(rpc.data)), error: null, viaRpc: true };
  if (!isMissingFunction(rpc.error)) return { data: null, error: rpc.error, viaRpc: true };
  const r = await supabase.from('loads').select(fallbackCols).order('created_at', { ascending: false });
  return { data: r.data || null, error: r.error || null, viaRpc: false };
}

// One load. → { data: load | null, error }. Owner fallback when the function is missing.
export async function fetchVisibleLoad(supabase, id) {
  const rpc = await supabase.rpc('visible_loads', { p_statuses: null, p_load: id });
  if (!rpc.error) return { data: unwrap(rpc.data)[0] || null, error: null };
  if (!isMissingFunction(rpc.error)) return { data: null, error: rpc.error };
  return supabase.from('loads').select('*, stops(*)').eq('id', id).maybeSingle();
}

// Owner-only controls on the load page (weight, status, driver settings, delete). The fallback path is owner-only.
export const isLoadOwnerView = (load) => !!load && (load.viewer_role == null || load.viewer_role === 'owner');

// Child cards (map, miles) patch the load after the server recalculates. When the database said this viewer can't
// see the rate (visible_loads().can_see_rate = false), rate fields in a patch are dropped (defense in depth; the
// map endpoint already leaves them out for drivers without "Show rate to driver").
export const RATE_KEYS = ['rate', 'rate_per_mile'];
export function mergeLoadPatch(load, patch) {
  if (!patch) return load;
  if (load?.can_see_rate !== false) return { ...load, ...patch };
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => !RATE_KEYS.includes(k)));
  return { ...load, ...clean };
}
