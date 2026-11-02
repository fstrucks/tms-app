// Facility rating prompts: server writes (service role only; clients can only read their own rows).
// Every helper is best effort: before migration 20261102000100 (or on any error) the stop check-off still succeeds.
import { shouldPromptUser, remindAtFor, recentSince, PROMPT_KINDS, OPEN_STATUSES } from './facilityRatingPrompts.js';
import { stopZone } from './stopTimesPdf.js';

const T = 'facility_rating_prompts';
const M = 'facility_rating_mutes';
const logErr = (where, e) => { if (e) console.error(`[rating-prompts] ${where}`, e.code || 'err'); };

export async function isMuted(svc, userId, facilityId) {
  if (!facilityId) return false;
  const { data, error } = await svc.from(M).select('facility_id').eq('user_id', userId).eq('facility_id', facilityId).maybeSingle();
  logErr('mute_read', error);
  return !!data;
}
export async function reviewedRecently(svc, userId, facilityId, now = new Date()) {
  if (!facilityId) return false;
  const { data, error } = await svc.from('facility_reviews').select('id').eq('author_id', userId).eq('facility_id', facilityId)
    .gte('updated_at', recentSince(now).toISOString()).not('stars', 'is', null).limit(1);
  logErr('recent_read', error);
  return !!data?.length;
}

// After a stop is marked done. Returns true when the immediate prompt should show.
// Not eligible (staff / dispatcher, wrong stop type) → false. Muted or reviewed this facility in the last 30 days → false.
// A stop without a facility still prompts (the prompt explains how to add one) but gets no reminder row.
export async function createPrompt(svc, { load, stop, userId, now = new Date() }) {
  try {
    if (!PROMPT_KINDS.includes(stop?.stop_type) || !shouldPromptUser(load, userId)) return false;
    if (!stop.facility_id) return true;
    if (await isMuted(svc, userId, stop.facility_id)) return false;
    if (await reviewedRecently(svc, userId, stop.facility_id, now)) return false;
    const timezone = stopZone(stop, null);
    const { error } = await svc.from(T).upsert({
      user_id: userId, load_id: load.id, stop_id: stop.id, facility_id: stop.facility_id, kind: stop.stop_type,
      status: 'pending', timezone, remind_at: remindAtFor(now, timezone).toISOString(),
    }, { onConflict: 'user_id,stop_id,kind', ignoreDuplicates: true });
    logErr('create', error);
    return true;
  } catch (e) { logErr('create_throw', e); return true; }
}

// Undo on the stop: drop the open prompt (any user's) so a re-mark starts fresh. Rated / dismissed rows stay.
export async function clearOpenPrompts(svc, stopId) {
  try { const { error } = await svc.from(T).delete().eq('stop_id', stopId).in('status', OPEN_STATUSES); logErr('clear', error); }
  catch (e) { logErr('clear_throw', e); }
}

// A review was saved for the stop.
export async function markRated(svc, userId, stopId) {
  try {
    const { error } = await svc.from(T).update({ status: 'rated', updated_at: new Date().toISOString() }).eq('user_id', userId).eq('stop_id', stopId).in('status', OPEN_STATUSES);
    logErr('rated', error);
  } catch (e) { logErr('rated_throw', e); }
}
