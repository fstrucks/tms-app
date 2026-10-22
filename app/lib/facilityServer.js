// Server side of facility reviews. Other users' reviews are read ONLY through the security-definer functions
// facility_summaries / facility_public_reviews (no author, company, load, rate or broker). A user's own review is
// read with author_id = caller. Writes go through the service role after the access + content checks.
import { publicReview, recentTips } from './facilityReviews.js';

export const OWN_COLS = 'id,stop_id,facility_id,stars,better_note,need_to_know,created_at,updated_at';
export const isMissing = (e) => !!e && ['42P01', '42883', '42703', 'PGRST202', 'PGRST205'].includes(e.code);

export async function summaries(svc, ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return { map: new Map() };
  const { data, error } = await svc.rpc('facility_summaries', { p_ids: list });
  if (error) return { error };
  return { map: new Map((data || []).map((r) => [r.facility_id, { name: r.name, city: r.city, state: r.state, avg: r.avg_stars == null ? null : Number(r.avg_stars), count: r.review_count || 0 }])) };
}
export async function publicReviews(svc, facilityId, limit = 50) {
  const { data, error } = await svc.rpc('facility_public_reviews', { p_facility: facilityId, p_limit: limit });
  return error ? { error } : { reviews: (data || []).map(publicReview) };
}
export async function tipsFor(svc, facilityId) {
  const r = await publicReviews(svc, facilityId, 20);
  return r.error ? [] : recentTips(r.reviews);
}
