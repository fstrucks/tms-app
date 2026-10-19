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
