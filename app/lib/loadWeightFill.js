// Follow-up to PR #69: when a rate con is (re-)extracted, copy its weight to the load it's linked to
// (documents.load_id). Only fills an EMPTY loads.weight (null); a weight already on the load, typed or copied, is
// always kept. Scoped to the caller's own load. Never throws; returns { filled, skipped?, error? }.
import { parseWeightLb } from './loadWeight.js';

export async function fillLinkedLoadWeight(db, { loadId, userId, weight }) {
  const lb = parseWeightLb(weight);
  if (!loadId) return { filled: false, skipped: 'no_linked_load' };
  if (!lb) return { filled: false, skipped: 'no_weight' };
  try {
    const { data, error } = await db.from('loads').update({ weight: lb }).eq('id', loadId).eq('user_id', userId).is('weight', null).select('id');
    if (error) return { filled: false, error };
    return data?.length ? { filled: true, weight: lb } : { filled: false, skipped: 'kept_existing' };
  } catch (error) { return { filled: false, error }; }
}
