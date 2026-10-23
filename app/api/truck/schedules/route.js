// Maintenance schedules (migration 20261023000300).
// GET ?truckId= → engines, truck engine fields, schedule rows with status. GET ?due=1 → due / overdue across the caller's trucks.
// POST { action }: preview (suggested checklist), setup (save engine + baseline + schedules), save_schedule, decode_vin.
// Reads and schedule writes use the caller's token (c.uc), so RLS and the SQL functions decide who sees what.
// Truck engine fields follow the Truck tab rule (c.db filtered by owner). Baseline visits: owner only, never an expense.
import { truckCtx, ownedTruck, json, isMissing, SETUP, UUID } from '../../../lib/truckServer';
import { isOffice, typeLabel } from '../../../lib/maintenance';
import { laToday } from '../../../lib/sendCap';
import { engineInput, checklistInput, intervalInput, decodeVin, sourceText, VPIC_URL } from '../../../lib/pmSchedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_EDIT = 'Only the owner or management can change maintenance schedules.';
const fail = (e, msg) => (isMissing(e) ? json(SETUP, 503) : e?.code === '42501' ? json({ error: NO_EDIT }, 403) : json({ error: msg }, 500));
const TRUCK_COLS = 'id,unit_number,vin,odometer,engine_make,engine_model,engine_year,duty_cycle,mpg,maint_setup_at';

async function engines(c) {
  const r = await c.uc.rpc('pm_engine_choices');
  return r.error ? { error: r.error } : { list: r.data || [] };
}

async function preview(c, patch) {
  const s = await c.uc.rpc('pm_suggest', { p_make: patch.engine_make, p_model: patch.engine_model, p_duty: patch.duty_cycle, p_mpg: patch.mpg });
  if (s.error) return { error: s.error };
  const ids = [...new Set((s.data || []).map((x) => x.template_id))];
  const t = ids.length ? await c.uc.from('maintenance_interval_templates').select('id,source_title,as_of_date,notes').in('id', ids) : { data: [] };
  if (t.error) return { error: t.error };
  const by = new Map(t.data.map((x) => [x.id, x]));
  return { items: (s.data || []).map((x) => {
    const tp = by.get(x.template_id) || {};
    const row = { ...x, source: 'suggested', source_title: tp.source_title, as_of_date: tp.as_of_date };
    return { serviceType: x.service_type, label: typeLabel({ service_type: x.service_type }), intervalMiles: x.interval_miles, intervalDays: x.interval_days, isGeneric: x.is_generic, sourceText: sourceText(row), notes: tp.notes || null };
  }) };
}

export async function GET(req, { deps } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  const q = new URL(req.url).searchParams;
  const today = laToday();
  if (q.get('due')) {
    const r = await c.uc.rpc('pm_due_list', { p_today: today });
    if (r.error) return isMissing(r.error) ? json({ available: false, due: [] }) : json({ error: 'Could not load maintenance due.' }, 500);
    return json({ available: true, today, due: (r.data || []).map((x) => ({ ...x, label: typeLabel({ service_type: x.service_type }) })) });
  }
  const truckId = q.get('truckId');
  if (!UUID.test(truckId || '') || !(await ownedTruck(c.db, c.ownerId, truckId))) return json({ error: 'Truck not found.' }, 404);
  const [tr, st, en] = await Promise.all([
    c.db.from('trucks').select(TRUCK_COLS).eq('id', truckId).eq('user_id', c.ownerId).maybeSingle(),
    c.uc.rpc('pm_status_for', { p_truck: truckId, p_today: today }),
    engines(c),
  ]);
  const err = tr.error || st.error || en.error;
  if (err) return isMissing(err) ? json({ available: false }) : json({ error: 'Could not load the maintenance schedule.' }, 500);
  return json({
    available: true, today, truck: tr.data, engines: en.list, canEdit: isOffice(c.role), canBaseline: c.role === 'owner',
    needsSetup: !tr.data?.maint_setup_at,
    schedule: (st.data || []).map((x) => ({ ...x, label: typeLabel({ service_type: x.service_type }), sourceText: sourceText(x) })),
  });
}

export async function POST(req, { deps, fetchImpl = fetch } = {}) {
  const c = await truckCtx(req, deps); if (c.res) return c.res;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!isOffice(c.role)) return json({ error: NO_EDIT }, 403);

  if (b.action === 'decode_vin') {
    const vin = String(b.vin || '').trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return json({ error: 'A VIN is 17 letters and numbers (no I, O or Q).' }, 422);
    const en = await engines(c); if (en.error) return fail(en.error, 'Could not load engines.');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetchImpl(VPIC_URL(vin), { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) return json({ error: 'The VIN lookup is not answering. Fill in the engine by hand.' }, 502);
      const d = decodeVin(await res.json(), en.list);
      return d.error ? json(d, 422) : json({ ok: true, decoded: d });
    } catch { return json({ error: 'The VIN lookup is not answering. Fill in the engine by hand.' }, 502); }
    finally { clearTimeout(timer); }
  }

  const truck = UUID.test(b.truckId || '') ? await ownedTruck(c.db, c.ownerId, b.truckId) : null;
  if (!truck) return json({ error: 'Truck not found.' }, 404);

  if (b.action === 'save_schedule') {
    if (!UUID.test(b.id || '')) return json({ error: 'Schedule not found.' }, 404);
    const v = intervalInput(b.values); if (v.error) return json(v, 422);
    const r = await c.uc.from('pm_schedules').update(v).eq('id', b.id).eq('truck_id', truck.id).select('id');
    if (r.error) return fail(r.error, 'Could not save the schedule.');
    if (!r.data?.length) return json({ error: 'Schedule not found.' }, 404);
    return json({ ok: true });
  }

  const en = await engines(c); if (en.error) return fail(en.error, 'Could not load engines.');
  const eng = engineInput(b.values, en.list); if (eng.error) return json(eng, 422);

  if (b.action === 'preview') {
    const p = await preview(c, eng.patch);
    return p.error ? fail(p.error, 'Could not load the suggested services.') : json({ ok: true, items: p.items });
  }

  if (b.action === 'setup') {
    const today = laToday();
    const raw = String(b.values?.odometer ?? '').replace(/[,\s]/g, '');
    const odo = raw === '' ? null : Number(raw);
    if (odo != null && (!Number.isInteger(odo) || odo < 0 || odo > 9999999)) return json({ error: 'Odometer must be a whole number.' }, 422);
    const cl = checklistInput(b.values?.items, { role: c.role, today, odometer: odo ?? truck.odometer ?? null });
    if (cl.error) return json(cl, 422);
    if (cl.baseline.length && odo == null && truck.odometer == null && cl.baseline.some((g) => g.odometer != null)) return json({ error: 'Enter the odometer first.' }, 422);

    const up = await c.db.from('trucks').update({ ...eng.patch, updated_at: new Date().toISOString() }).eq('id', truck.id).eq('user_id', c.ownerId);
    if (up.error) return fail(up.error, 'Could not save the engine.');
    if (odo != null && odo !== truck.odometer) {
      const o = await c.uc.rpc('set_truck_odometer', { p_truck: truck.id, p_odometer: odo });
      if (o.error) return fail(o.error, 'Could not save the odometer.');
    }
    // Baseline visits first, so the new schedules start from them.
    let visits = 0;
    for (const g of cl.baseline) {
      const r = await c.uc.from('service_records').insert({ truck_id: truck.id, owner_id: c.ownerId, service_date: g.service_date, odometer: g.odometer, entry_source: 'baseline', add_to_expenses: false, total_cost: 0, notes: 'Recorded during truck setup' }).select('id').single();
      if (r.error) return fail(r.error, 'Could not save the past services.');
      const it = await c.uc.from('service_record_items').insert(g.items.map((t) => ({ service_record_id: r.data.id, service_type: t })));
      if (it.error) { await c.uc.from('service_records').delete().eq('id', r.data.id); return fail(it.error, 'Could not save the past services.'); }
      visits++;
    }
    const s = await c.uc.rpc('pm_setup_schedules', { p_truck: truck.id, p_start: cl.start });
    if (s.error) return fail(s.error, 'Could not create the schedules.');
    const done = await c.db.from('trucks').update({ maint_setup_at: new Date().toISOString() }).eq('id', truck.id).eq('user_id', c.ownerId);
    if (done.error) return fail(done.error, 'Schedules saved, but setup could not be marked done.');
    return json({ ok: true, schedules: s.data ?? 0, visits });
  }
  return json({ error: 'Bad request.' }, 400);
}
