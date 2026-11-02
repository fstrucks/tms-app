// The caller's facility rating reminder cards.
//   GET ?loadId= → { cards: [{ id, stopId, loadId, kind, facilityName, state }] }  due now ('first') or shown earlier today ('again')
//   POST { stopId, action } → { ok }
//     skip             "Skip" on the immediate prompt: pending → skipped (the 9 AM next-day reminder still comes)
//     shown            the reminder card was displayed: → reminded, reminded_at = now (only the first time)
//     dismiss          "Skip" / close on the reminder card: → dismissed (never again)
//     dismiss_facility "Don't ask about this facility again": mute + close every open prompt for that facility
// Own rows only (filtered by user_id, service role). Before migration 20261102000100: { cards: [] } / { ok: false }.
import { loadDocsCtx, json, UUID } from '../../lib/loadDocsServer';
import { isMissing } from '../../lib/truckServer';
import { cardState, OPEN_STATUSES, PROMPT_ACTIONS } from '../../lib/facilityRatingPrompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const T = 'facility_rating_prompts';
const COLS = 'id,stop_id,load_id,facility_id,kind,status,timezone,remind_at,reminded_at';
const nowOf = (deps) => (deps?.now ? new Date(deps.now()) : new Date());

export async function GET(req, { deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  const loadId = new URL(req.url).searchParams.get('loadId');
  if (loadId && !UUID.test(loadId)) return json({ cards: [] });
  const now = nowOf(deps);
  let q = x.svc.from(T).select(COLS).eq('user_id', x.c.user.id).in('status', OPEN_STATUSES).lte('remind_at', now.toISOString()).order('remind_at', { ascending: true }).limit(20);
  if (loadId) q = q.eq('load_id', loadId);
  const { data, error } = await q;
  if (error) { if (!isMissing(error)) console.error('[rating-prompts] list', error.code); return json({ cards: [] }); }
  const due = (data || []).map((r) => ({ r, state: cardState(r, now) })).filter((c) => c.state);
  const ids = [...new Set(due.map((c) => c.r.facility_id))];
  let names = {};
  if (ids.length) {
    const { data: f } = await x.svc.from('facilities').select('id,name').in('id', ids);
    names = Object.fromEntries((f || []).map((r) => [r.id, r.name]));
  }
  return json({ cards: due.map(({ r, state }) => ({ id: r.id, stopId: r.stop_id, loadId: r.load_id, kind: r.kind, facilityName: names[r.facility_id] || '', state })) });
}

export async function POST(req, { deps } = {}) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!UUID.test(body?.stopId || '') || !PROMPT_ACTIONS.includes(body?.action)) return json({ error: 'Bad request.' }, 400);
  const uid = x.c.user.id; const now = nowOf(deps).toISOString();
  const fail = (e) => { if (isMissing(e)) return json({ ok: false }); console.error('[rating-prompts] post', e.code); return json({ error: 'That didn’t save. Please try again.' }, 500); };
  let r;
  if (body.action === 'skip') r = await x.svc.from(T).update({ status: 'skipped', updated_at: now }).eq('user_id', uid).eq('stop_id', body.stopId).eq('status', 'pending');
  else if (body.action === 'shown') r = await x.svc.from(T).update({ status: 'reminded', reminded_at: now, updated_at: now }).eq('user_id', uid).eq('stop_id', body.stopId).in('status', ['pending', 'skipped']).is('reminded_at', null);
  else if (body.action === 'dismiss') r = await x.svc.from(T).update({ status: 'dismissed', updated_at: now }).eq('user_id', uid).eq('stop_id', body.stopId).in('status', OPEN_STATUSES);
  else {
    // The facility comes from the caller's own prompt row, or (first prompt on a stop without a row) the stop itself
    // on a load the caller may check off. Never trust a facility id from the client.
    let facilityId = null;
    const p = await x.svc.from(T).select('facility_id').eq('user_id', uid).eq('stop_id', body.stopId).limit(1);
    if (p.error) return fail(p.error);
    facilityId = p.data?.[0]?.facility_id || null;
    if (!facilityId) {
      const { data: s } = await x.svc.from('stops').select('facility_id, loads!inner(user_id,assigned_driver_user_id)').eq('id', body.stopId).maybeSingle();
      const l = s?.loads; const ok = l && (l.assigned_driver_user_id ? l.assigned_driver_user_id === uid : l.user_id === uid);
      facilityId = ok ? s.facility_id : null;
    }
    if (!facilityId) return json({ error: 'Facility not found.' }, 404);
    const m = await x.svc.from('facility_rating_mutes').upsert({ user_id: uid, facility_id: facilityId }, { onConflict: 'user_id,facility_id', ignoreDuplicates: true });
    if (m.error) return fail(m.error);
    r = await x.svc.from(T).update({ status: 'dismissed', updated_at: now }).eq('user_id', uid).eq('facility_id', facilityId).in('status', OPEN_STATUSES);
  }
  if (r.error) return fail(r.error);
  return json({ ok: true });
}
