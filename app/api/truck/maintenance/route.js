// Truck maintenance log. Reads and writes use the CALLER's token (c.uc), so the RLS policies of migration
// 20261023000100 decide who sees and changes what (owner / management full, dispatcher read only, driver his truck and
// his own entries for 24 h). The expense, owner_id and odometer bump are done by database triggers, not here.
// GET ?truckId= → { available, visits, loads, canLog, odometer }   (available:false when the migration isn't applied)
// POST { action: 'create' | 'update' | 'delete' | 'set_odometer', ... }
import { truckCtx, json, isMissing, UUID } from '../../../lib/truckServer';
import { visitInput, shapeHistory, canLogService, isOffice, canChangeVisit } from '../../../lib/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_READY = { available: false, visits: [], loads: [] };
const denied = (e) => !!e && (e.code === '42501' || /row-level security|not_allowed|permission denied/i.test(e.message || ''));
const errMsg = (e, fallback) => {
  if (/odometer_jump/.test(e?.message || '')) return json({ error: 'That’s more than 50,000 miles above the current odometer. Ask the owner to enter it.' }, 422);
  if (/load_not_allowed/.test(e?.message || '')) return json({ error: 'That load isn’t one you can pick.' }, 422);
  if (denied(e)) return json({ error: 'You can’t change this entry.' }, 403);
  if (isMissing(e)) return json({ ...NOT_READY, error: 'Maintenance needs a database update first.' }, 503);
  return json({ error: fallback }, 500);
};

async function history(c, truckId) {
  const rec = await c.uc.from('service_records').select('*').eq('truck_id', truckId).order('service_date', { ascending: false }).limit(100);
  if (rec.error) return isMissing(rec.error) ? { missing: true } : { error: rec.error };
  const ids = (rec.data || []).map((r) => r.id);
  let items = [], docs = [];
  if (ids.length) {
    const it = await c.uc.from('service_record_items').select('*').in('service_record_id', ids);
    if (it.error) return isMissing(it.error) ? { missing: true } : { error: it.error };
    items = it.data || [];
    const dc = await c.uc.from('documents').select('id,file_path,original_filename,service_record_id').in('service_record_id', ids);
    docs = dc.error ? [] : dc.data || [];
  }
  const loadIds = [...new Set((rec.data || []).map((r) => r.load_id).filter(Boolean))];
  return { visits: shapeHistory(rec.data || [], items, docs), loadIds };
}

export async function GET(req, { deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  const truckId = new URL(req.url).searchParams.get('truckId');
  if (!UUID.test(truckId || '')) return json({ error: 'Truck not found.' }, 404);
  const h = await history(c, truckId);
  if (h.missing) return json(NOT_READY);
  if (h.error) return json({ error: 'Could not load maintenance.' }, 500);
  let loads = [];
  if (canLogService(c.role)) {
    const lc = await c.uc.rpc('maint_load_choices', { p_truck: truckId });
    if (lc.error && isMissing(lc.error)) return json(NOT_READY);
    loads = lc.data || [];
  }
  const tr = await c.db.from('trucks').select('id,odometer,odometer_updated_at').eq('id', truckId).eq('user_id', c.ownerId).maybeSingle();
  return json({
    available: true, visits: h.visits.map((v) => ({ ...v, canChange: canChangeVisit(c.role, c.user.id, v) })), loads,
    role: c.role, canLog: canLogService(c.role), canSetOdometer: isOffice(c.role),
    odometer: tr.data?.odometer ?? null, odometerUpdatedAt: tr.data?.odometer_updated_at ?? null,
  });
}

export async function POST(req, { deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!canLogService(c.role)) return json({ error: 'Dispatch can view maintenance but not change it.' }, 403);

  if (b.action === 'set_odometer') {
    if (!isOffice(c.role)) return json({ error: 'Only the owner or management can change the odometer.' }, 403);
    const n = Number(String(b.odometer ?? '').replace(/[,\s]/g, ''));
    if (!UUID.test(b.truckId || '') || !Number.isInteger(n) || n < 0 || n > 9999999) return json({ error: 'Miles must be a whole number.' }, 422);
    const r = await c.uc.rpc('set_truck_odometer', { p_truck: b.truckId, p_odometer: n });
    if (r.error) return errMsg(r.error, 'Could not save the odometer.');
    return json({ ok: true, odometer: n, odometerUpdatedAt: r.data });
  }

  if (b.action === 'delete') {
    if (!UUID.test(b.id || '')) return json({ error: 'Entry not found.' }, 404);
    // Receipt rows are deleted by the database (BEFORE delete trigger); the files are removed here, best effort,
    // with the caller's token (Storage policies decide which ones he may remove).
    const docs = await c.uc.from('documents').select('file_path').eq('service_record_id', b.id).eq('doc_type', 'maintenance_receipt');
    const r = await c.uc.from('service_records').delete().eq('id', b.id).select('id');
    if (r.error) return errMsg(r.error, 'Could not delete the entry.');
    if (!r.data?.length) return json({ error: 'You can’t delete this entry.' }, 403);
    const paths = (docs.data || []).map((d) => d.file_path).filter(Boolean);
    let filesLeft = 0;
    if (paths.length && c.uc.storage) {
      let rm; try { rm = await c.uc.storage.from('documents').remove(paths); } catch (e) { rm = { error: e }; }
      filesLeft = rm?.error ? paths.length : Math.max(0, paths.length - (rm?.data?.length ?? paths.length));
    }
    if (filesLeft) console.error('[maintenance] receipt files left in storage', b.id, filesLeft);
    return json({ ok: true });
  }

  if (b.action !== 'create' && b.action !== 'update') return json({ error: 'Bad request.' }, 400);
  const v = visitInput(b.values, { role: c.role });
  if (v.error) return json({ error: v.error }, 422);

  if (b.action === 'create') {
    if (!UUID.test(b.truckId || '')) return json({ error: 'Truck not found.' }, 404);
    const r = await c.uc.from('service_records').insert({ ...v.visit, truck_id: b.truckId, owner_id: c.ownerId }).select('id').single();
    if (r.error) return errMsg(r.error, 'Could not save the service.');
    const it = await c.uc.from('service_record_items').insert(v.items.map((x) => ({ ...x, service_record_id: r.data.id })));
    if (it.error) { await c.uc.from('service_records').delete().eq('id', r.data.id); return errMsg(it.error, 'Could not save the services.'); }
    return json({ ok: true, id: r.data.id });
  }

  if (!UUID.test(b.id || '')) return json({ error: 'Entry not found.' }, 404);
  const { entry_source, ...patch } = v.visit; // entry_source is fixed once saved
  const r = await c.uc.from('service_records').update(patch).eq('id', b.id).select('id');
  if (r.error) return errMsg(r.error, 'Could not save the service.');
  if (!r.data?.length) return json({ error: 'You can’t change this entry.' }, 403);
  const del = await c.uc.from('service_record_items').delete().eq('service_record_id', b.id);
  if (del.error) return errMsg(del.error, 'Could not save the services.');
  const it = await c.uc.from('service_record_items').insert(v.items.map((x) => ({ ...x, service_record_id: b.id })));
  if (it.error) return errMsg(it.error, 'Could not save the services.');
  return json({ ok: true, id: b.id });
}
