// Server: the load (with stops) + carrier name for the Stop times sheet, with the stop check-off access rule.
import { json, UUID } from './loadDocsServer.js';
import { canCompleteStops } from './stopProgress.js';

export async function loadForStopTimes(x, loadId) {
  const { c, svc } = x;
  if (!UUID.test(loadId || '')) return { res: json({ error: 'Load not found.' }, 404) };
  const { data: load, error } = await svc.from('loads').select('id,user_id,status,broker_load_number,broker_name,assigned_driver_user_id, stops(*)').eq('id', loadId).maybeSingle();
  if (error) return { res: json({ error: 'Couldn’t load this load.' }, 500) };
  if (!load) return { res: json({ error: 'Load not found.' }, 404) };
  let role = load.user_id === c.ownerId ? c.role : null;
  if (!role && c.uc) { const { data: r2 } = await c.uc.rpc('packet_role', { p_owner: load.user_id }); role = typeof r2 === 'string' ? r2 : null; }
  if (!role && load.assigned_driver_user_id === c.user.id) role = 'driver';
  if (!role || !canCompleteStops(role, load, c.user.id)) return { res: json({ error: 'Load not found.' }, 404) };
  const { data: company } = await svc.from('company_profiles').select('legal_name,dba_name').eq('owner_id', load.user_id).maybeSingle();
  return { load, company: company || null };
}

