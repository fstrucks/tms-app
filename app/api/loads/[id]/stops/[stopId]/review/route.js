// The caller's own review of a stop's facility (one per stop per user; editable).
//   GET → { review | null, canReview }
//   PUT { stars, better_note?, need_to_know? } → { review }
// Access: same as stop check-off (company staff, or the load's assigned driver). Only picked-up / delivered stops
// that match a facility. Notes go through the content filter (no phone, email, links or profanity).
import { loadDocsCtx, json, UUID } from '../../../../../../lib/loadDocsServer.js';
import { loadForStopTimes } from '../../../../../../lib/stopTimesServer.js';
import { cleanReview, reviewState, NO_FACILITY_MSG } from '../../../../../../lib/facilityReviews.js';
import { OWN_COLS, isMissing } from '../../../../../../lib/facilityServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const SETUP = { error: 'Facility reviews need a database update that hasn’t been applied yet.', setupNeeded: true };

async function ctx(req, params, deps) {
  const x = await loadDocsCtx(req, deps); if (x.res) return x;
  const r = await loadForStopTimes(x, params?.id); if (r.res) return r;
  if (!UUID.test(params?.stopId || '')) return { res: json({ error: 'Stop not found.' }, 404) };
  const stop = (r.load.stops || []).find((s) => s.id === params.stopId);
  if (!stop) return { res: json({ error: 'Stop not found.' }, 404) };
  return { ...x, load: r.load, stop };
}
const own = (r) => Object.fromEntries(OWN_COLS.split(',').map((k) => [k, r[k] ?? null])); // never send author/company back
const mine = (x) => x.svc.from('facility_reviews').select(OWN_COLS).eq('stop_id', x.stop.id).eq('author_id', x.c.user.id).maybeSingle();

export async function GET(req, { params, deps } = {}) {
  const x = await ctx(req, params, deps); if (x.res) return x.res;
  if (!Object.prototype.hasOwnProperty.call(x.stop, 'facility_id')) return json(SETUP, 409);
  const { data, error } = await mine(x);
  if (error) return isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t load your review.' }, 500);
  const state = reviewState(x.stop);
  return json({ review: data || null, canReview: state === 'review' || state === 'link', state, ...(state === 'missing' ? { message: NO_FACILITY_MSG } : {}) });
}

export async function PUT(req, { params, deps } = {}) {
  const x = await ctx(req, params, deps); if (x.res) return x.res;
  const state = reviewState(x.stop);
  if (!state) return json({ error: 'You can review a facility after the stop is picked up or delivered.' }, 409);
  if (state === 'missing') return json({ error: NO_FACILITY_MSG, state }, 409);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const c = cleanReview(body); if (c.error) return json({ error: c.error, field: c.field }, 422);
  if (state === 'link') { // older stop (e.g. from a rate con) that the backfill couldn't match: create / link its facility now
    const l = await x.svc.rpc('facility_link_stop', { p_stop: x.stop.id });
    if (l.error) return isMissing(l.error) || l.error.code === 'PGRST202' ? json(SETUP, 409) : json({ error: 'Couldn’t save your review.' }, 500);
    if (!l.data) return json({ error: NO_FACILITY_MSG, state: 'missing' }, 409);
    x.stop = { ...x.stop, facility_id: l.data };
  }
  const cur = await mine(x);
  if (cur.error) return isMissing(cur.error) ? json(SETUP, 409) : json({ error: 'Couldn’t save your review.' }, 500);
  const now = new Date().toISOString();
  let res;
  if (cur.data) res = await x.svc.from('facility_reviews').update({ ...c.row, facility_id: x.stop.facility_id, updated_at: now }).eq('id', cur.data.id).eq('author_id', x.c.user.id).select(OWN_COLS).maybeSingle();
  else {
    const { data: co } = await x.svc.from('company_profiles').select('id').eq('owner_id', x.load.user_id).maybeSingle();
    res = await x.svc.from('facility_reviews').insert({ ...c.row, facility_id: x.stop.facility_id, stop_id: x.stop.id, author_id: x.c.user.id, company_id: co?.id || null }).select(OWN_COLS).maybeSingle();
    if (res.error?.code === '23505') { // a second tap raced the first: update that one
      const again = await mine(x);
      if (again.data) res = await x.svc.from('facility_reviews').update({ ...c.row, updated_at: now }).eq('id', again.data.id).eq('author_id', x.c.user.id).select(OWN_COLS).maybeSingle();
    }
  }
  if (res.error || !res.data) return isMissing(res.error) ? json(SETUP, 409) : json({ error: 'Couldn’t save your review.' }, 500);
  return json({ review: own(res.data) });
}
