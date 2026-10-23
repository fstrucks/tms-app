// Hand-off from /loads/new to /loads/[id] (#86 QA): the just-created load (with its stops) is kept in memory for one
// read, so the load page shows it at once instead of "Loading load…" while it re-fetches. Client navigation keeps
// this module alive; a full reload simply finds nothing and fetches as before.
const seeds = new Map();
export function seedLoad(load) { if (load?.id) seeds.set(String(load.id), load); }
export function takeSeededLoad(id) {
  const k = String(id || '');
  const l = seeds.get(k);
  seeds.delete(k);
  return l || null;
}

// Right after Create load (QA Oct 22): the first reads can race the new rows (the map / Scale tickets cards said
// "Load not found." and stop ratings were missing until a reload). The load page re-reads once, a moment later,
// when the load is new (created < 2 min ago) or wasn't found on the first try.
export const SETTLE_RETRY_MS = 1500;
export const FRESH_LOAD_MS = 2 * 60 * 1000;
export function isFreshLoad(load, now = Date.now()) {
  const t = Date.parse(load?.created_at || '');
  return Number.isFinite(t) && now - t >= -60000 && now - t < FRESH_LOAD_MS;
}
