// Server helpers for /api/truck/*. Row security on trucks/trailers/drivers/scale_tickets stays own-rows
// (user_id = auth.uid()). The owner reads and writes with their OWN token, so RLS applies. Company members
// (dispatcher / management / driver, via company_members + packet_role) can't pass own-row RLS on the owner's
// rows, so their requests use the service client and EVERY query is filtered by user_id = ownerId.
// Drivers are read-only (canEditTruck), and the server enforces it.
import { userClient, serviceClient, bearer, isAuthRejection, checkUser, jwtClaims } from './packetServer.js';
import { isRole } from './companyRoles.js';
import { canEditTruck, weightChecks, latestWeight } from './truckFields.js';

export const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
export const isMissing = (e) => !!e && (e.code === '42P01' || e.code === '42703' || e.code === 'PGRST204' || e.code === 'PGRST205' || /does not exist|Could not find the/i.test(e.message || ''));
export const SETUP = { error: 'The Truck tab needs a database update that hasn’t been applied yet.', setupNeeded: true };
export const READ_ONLY_MSG = 'Drivers can view the Truck tab but not change it.';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PGRST_JWT = new Set(['PGRST301', 'PGRST302', 'PGRST303']);
const isJwtError = (e) => !!e && (PGRST_JWT.has(e.code) || isAuthRejection(e));
const UNAVAILABLE = 'Couldn’t check your sign-in just now. Try again.';
const EXPIRED = 'Your sign-in expired. Please sign in again.';

// → { db, user, ownerId, role, canEdit } | { res }
// Same Auth handling as the map and packet endpoints (PROD smoke after #86): one quick retry of the Auth check, and
// when Supabase Auth still can't answer (5xx, rate limit, network) the token is verified by the database instead
// (PostgREST checks the JWT signature on the company_profiles read and the packet_role call). Before this, a single
// Auth hiccup right after the New load redirect showed a red "Couldn't check your sign-in" on the Scale tickets card.
export async function truckCtx(req, { mkUserClient = userClient, sb: svc, mkService = serviceClient, authRetryMs } = {}) {
  const token = bearer(req);
  if (!token) return { res: json({ error: 'Sign in first.' }, 401) };
  const uc = mkUserClient(token);
  const who = await checkUser(uc, token, authRetryMs != null ? { retryMs: authRetryMs } : {});
  if (who.rejected) return { res: json({ error: EXPIRED, auth: true }, 401) };
  let user = who.user || null;
  if (who.unavailable) {
    const c = jwtClaims(token);
    if (!c?.sub) return { res: json({ error: UNAVAILABLE, retry: true }, 503) };
    if ((c.exp && c.exp * 1000 < Date.now()) || (c.role && c.role !== 'authenticated')) return { res: json({ error: EXPIRED, auth: true }, 401) };
    const e = who.error;
    console.error('[truck] auth check unavailable, verifying via database', e?.status ?? '', e?.code ?? '', String(e?.message || e || '').slice(0, 160));
    user = { id: c.sub, email: c.email || null, verified: 'database' };
  }
  const { data: profiles, error } = await uc.from('company_profiles').select('*').limit(1);
  if (isJwtError(error)) return { res: json({ error: EXPIRED, auth: true }, 401) };
  if (error && !isMissing(error)) return { res: json({ error: 'Could not load your company.' }, 500) };
  const ownerId = profiles?.[0]?.owner_id || user.id;
  const { data: role, error: rErr } = await uc.rpc('packet_role', { p_owner: ownerId });
  if (isJwtError(rErr)) return { res: json({ error: EXPIRED, auth: true }, 401) };
  if (rErr && who.unavailable) return { res: json({ error: UNAVAILABLE, retry: true }, 503) }; // database couldn't vouch either
  if (!isRole(role)) return { res: json({ error: 'Not allowed.' }, 403) };
  let db = uc;
  if (ownerId !== user.id) {
    db = svc || mkService();
    if (!db) return { res: json({ error: 'The Truck tab isn’t set up for team members yet.' }, 503) };
  }
  return { db, uc, user, ownerId, role, canEdit: canEditTruck(role) };
}

// Everything the Truck tab shows, for one truck. → data | { setupNeeded } | { error }
export async function loadTruckData(db, ownerId, { truckId = null, userId = null } = {}) {
  const tr = await db.from('trucks').select('*').eq('user_id', ownerId).order('unit_number');
  if (tr.error) return isMissing(tr.error) ? { setupNeeded: true } : { error: 'Could not load your trucks.' };
  const dr = await db.from('drivers').select('*').eq('user_id', ownerId).eq('active', true);
  if (dr.error) return isMissing(dr.error) ? { setupNeeded: true } : { error: 'Could not load drivers.' };
  const tl = await db.from('trailers').select('*').eq('user_id', ownerId).order('unit_number');
  if (tl.error) return isMissing(tl.error) ? { setupNeeded: true } : { error: 'Could not load trailers.' };
  const trucks = tr.data || [], drivers = dr.data || [], trailers = tl.data || [];
  const mine = userId ? drivers.find((d) => d.auth_user_id === userId) : null; // a driver's own truck first
  const truck = trucks.find((t) => t.id === truckId) || trucks.find((t) => t.id === mine?.truck_id) || trucks[0] || null;
  const recent = await db.from('loads').select('id,broker_load_number,broker_name,weight,created_at').eq('user_id', ownerId).order('created_at', { ascending: false }).limit(20);
  const loads = recent.data || [];
  if (!truck) return { trucks: [], trailers, truck: null, trailer: null, driver: null, tickets: [], latest: null, loads };
  const trailer = trailers.find((t) => t.id === truck.current_trailer_id) || null;
  const driver = drivers.find((d) => d.truck_id === truck.id) || null;
  const tk = await db.from('scale_tickets').select('*').eq('user_id', ownerId).eq('truck_id', truck.id)
    .order('ticket_date', { ascending: false }).order('created_at', { ascending: false }).limit(50);
  if (tk.error) return isMissing(tk.error) ? { setupNeeded: true } : { error: 'Could not load scale tickets.' };
  const rows = tk.data || [];
  const loadIds = [...new Set(rows.map((t) => t.load_id).filter(Boolean))].filter((id) => !loads.some((l) => l.id === id));
  let linked = [];
  if (loadIds.length) linked = (await db.from('loads').select('id,broker_load_number,broker_name,weight').eq('user_id', ownerId).in('id', loadIds)).data || [];
  const loadById = new Map([...loads, ...linked].map((l) => [l.id, l]));
  const tickets = rows.map((t) => {
    const tlr = trailers.find((x) => x.id === t.trailer_id) || trailer;
    const load = t.load_id ? loadById.get(t.load_id) || null : null;
    return { ...t, load, ...weightChecks({ ticket: t, truckEmpty: truck.empty_weight_lb, trailerEmpty: tlr?.empty_weight_lb, loadWeight: load?.weight }) };
  });
  return { trucks: trucks.map((t) => ({ id: t.id, unit_number: t.unit_number })), trailers, truck, trailer, driver, tickets, latest: latestWeight(tickets.filter((t) => t.confirmed)), loads };
}

export async function ownedTruck(db, ownerId, truckId) {
  if (!UUID.test(truckId || '')) return null;
  const { data } = await db.from('trucks').select('*').eq('id', truckId).eq('user_id', ownerId).maybeSingle();
  return data || null;
}
export async function ownedLoad(db, ownerId, loadId) {
  if (!loadId) return true;
  if (!UUID.test(loadId)) return false;
  const { data } = await db.from('loads').select('id').eq('id', loadId).eq('user_id', ownerId).maybeSingle();
  return !!data;
}

// Scale tickets linked to one load (load page). Same scoping as the Truck tab: every query is filtered by
// user_id = ownerId. Warnings come from the shared weightChecks() helper; the rate con check uses the load's weight.
// → { load, tickets } | { notFound } | { setupNeeded } | { error }
export async function loadTicketsForLoad(db, ownerId, loadId) {
  if (!UUID.test(loadId || '')) return { notFound: true };
  const ld = await db.from('loads').select('id,weight,broker_load_number').eq('id', loadId).eq('user_id', ownerId).maybeSingle();
  if (ld.error) return { error: 'Could not load the load.' };
  if (!ld.data) return { notFound: true };
  const tk = await db.from('scale_tickets').select('*').eq('user_id', ownerId).eq('load_id', loadId)
    .order('ticket_date', { ascending: false }).order('created_at', { ascending: false }).limit(50);
  if (tk.error) return isMissing(tk.error) ? { setupNeeded: true } : { error: 'Could not load scale tickets.' };
  const rows = tk.data || [];
  if (!rows.length) return { load: ld.data, tickets: [] };
  const truckIds = [...new Set(rows.map((t) => t.truck_id).filter(Boolean))];
  const trucks = (await db.from('trucks').select('id,unit_number,empty_weight_lb,current_trailer_id').eq('user_id', ownerId).in('id', truckIds)).data || [];
  const trailerIds = [...new Set([...rows.map((t) => t.trailer_id), ...trucks.map((t) => t.current_trailer_id)].filter(Boolean))];
  const trailers = trailerIds.length ? (await db.from('trailers').select('id,unit_number,empty_weight_lb').eq('user_id', ownerId).in('id', trailerIds)).data || [] : [];
  const tickets = rows.map((t) => {
    const truck = trucks.find((x) => x.id === t.truck_id) || null;
    const trailer = trailers.find((x) => x.id === t.trailer_id) || trailers.find((x) => x.id === truck?.current_trailer_id) || null;
    return { ...t, truck_number: truck?.unit_number || null, trailer_number: trailer?.unit_number || null,
      ...weightChecks({ ticket: t, truckEmpty: truck?.empty_weight_lb, trailerEmpty: trailer?.empty_weight_lb, loadWeight: ld.data.weight }) };
  });
  return { load: ld.data, tickets };
}
