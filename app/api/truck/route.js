// Truck tab data. GET → everything for one truck (?truckId=). POST { action, ... } saves truck / trailer / driver.
// Drivers get read-only (403 on POST). See app/lib/truckServer.js for how row security is kept own-rows.
import { truckCtx, loadTruckData, ownedTruck, json, isMissing, SETUP, READ_ONLY_MSG, UUID } from '../../lib/truckServer';
import { truckInput, trailerInput, driverInput } from '../../lib/truckFields';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function respond(c, truckId) {
  const d = await loadTruckData(c.db, c.ownerId, { truckId, userId: c.user.id });
  if (d.setupNeeded) return json(SETUP, 503);
  if (d.error) return json({ error: d.error }, 500);
  return json({ ...d, role: c.role, canEdit: c.canEdit });
}

export async function GET(req, { deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  return respond(c, new URL(req.url).searchParams.get('truckId'));
}

export async function POST(req, { deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  if (!c.canEdit) return json({ error: READ_ONLY_MSG }, 403);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const now = new Date().toISOString();
  const fail = (e, msg) => (isMissing(e) ? json(SETUP, 503) : json({ error: msg }, 500));

  if (b.action === 'save_truck') {
    const v = truckInput(b.values); if (v.error) return json({ error: v.error }, 422);
    if (b.id) {
      if (!(await ownedTruck(c.db, c.ownerId, b.id))) return json({ error: 'Truck not found.' }, 404);
      const r = await c.db.from('trucks').update({ ...v.patch, updated_at: now }).eq('id', b.id).eq('user_id', c.ownerId);
      if (r.error) return fail(r.error, 'Could not save the truck.');
      return respond(c, b.id);
    }
    const r = await c.db.from('trucks').insert({ ...v.patch, user_id: c.ownerId }).select('id').single();
    if (r.error) return r.error.code === '23505' ? json({ error: 'You already have a truck with that number or VIN.' }, 409) : fail(r.error, 'Could not add the truck.');
    return respond(c, r.data.id);
  }

  const truck = await ownedTruck(c.db, c.ownerId, b.truckId);
  if (!truck) return json({ error: 'Truck not found.' }, 404);

  if (b.action === 'save_trailer') {
    const v = trailerInput(b.values); if (v.error) return json({ error: v.error }, 422);
    if (b.id) {
      if (!UUID.test(b.id)) return json({ error: 'Trailer not found.' }, 404);
      const r = await c.db.from('trailers').update({ ...v.patch, updated_at: now }).eq('id', b.id).eq('user_id', c.ownerId).select('id').maybeSingle();
      if (r.error) return fail(r.error, 'Could not save the trailer.');
      if (!r.data) return json({ error: 'Trailer not found.' }, 404);
      if (truck.current_trailer_id !== b.id) await c.db.from('trucks').update({ current_trailer_id: b.id, updated_at: now }).eq('id', truck.id).eq('user_id', c.ownerId);
      return respond(c, truck.id);
    }
    const r = await c.db.from('trailers').insert({ ...v.patch, user_id: c.ownerId }).select('id').single();
    if (r.error) return r.error.code === '23505' ? json({ error: 'You already have a trailer with that number.' }, 409) : fail(r.error, 'Could not add the trailer.');
    const link = await c.db.from('trucks').update({ current_trailer_id: r.data.id, updated_at: now }).eq('id', truck.id).eq('user_id', c.ownerId);
    if (link.error) return fail(link.error, 'Trailer saved, but it couldn’t be linked to the truck.');
    return respond(c, truck.id);
  }

  if (b.action === 'save_driver') {
    const v = driverInput(b.values); if (v.error) return json({ error: v.error }, 422);
    // One active driver per truck (no team drivers; partial unique index in the migration backs this up).
    const { data: onTruck } = await c.db.from('drivers').select('id').eq('user_id', c.ownerId).eq('truck_id', truck.id).eq('active', true);
    if ((onTruck || []).some((d) => d.id !== b.id)) return json({ error: 'This truck already has a driver. Edit that driver instead.' }, 409);
    const row = { ...v.patch, truck_id: truck.id, updated_at: now };
    const r = b.id
      ? await c.db.from('drivers').update(row).eq('id', b.id).eq('user_id', c.ownerId).select('id').maybeSingle()
      : await c.db.from('drivers').insert({ ...row, user_id: c.ownerId, active: true }).select('id').single();
    if (r.error) return r.error.code === '23505' ? json({ error: 'This truck already has a driver. Edit that driver instead.' }, 409) : fail(r.error, 'Could not save the driver.');
    if (!r.data) return json({ error: 'Driver not found.' }, 404);
    return respond(c, truck.id);
  }
  return json({ error: 'Bad request.' }, 400);
}
