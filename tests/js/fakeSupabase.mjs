// Minimal in-memory Supabase client for route tests (no network). Supports the chains the Truck routes use:
// from(t).select().eq().in().order().limit().maybeSingle()/single()/await, insert().select().single(),
// update().eq()…select().maybeSingle(), delete().eq(), storage.download, auth.getUser, rpc.
// unique: { table: [['col', ...], ...] } → 23505 on insert/update, with optional where(row) for partial indexes.
let seq = 0;
export const fakeId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function fakeSupabase({ tables = {}, user = null, role = 'owner', files = {}, unique = {}, missing = [] } = {}) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const calls = [];
  const violates = (t, row, selfId) => (unique[t] || []).some(({ cols, where }) => (!where || where(row)) &&
    (db[t] || []).some((o) => o.id !== selfId && (!where || where(o)) && cols.every((c) => o[c] != null && o[c] === row[c])));
  function q(t) {
    const st = { t, filters: [], eqs: [], ins: [], op: 'select', order: [], lim: null, payload: null, wantRow: false };
    const match = (r) => st.filters.every((f) => f(r));
    const run = () => {
      calls.push({ t, op: st.op, eqs: st.eqs, ins: st.ins, payload: st.payload });
      if (missing.includes(t)) return { data: null, error: { code: '42P01', message: `relation "${t}" does not exist` } };
      db[t] = db[t] || [];
      if (st.op === 'insert') {
        const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: r.id || fakeId(), created_at: new Date(Date.now() + seq).toISOString(), ...r }));
        for (const r of rows) if (violates(t, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        db[t].push(...rows);
        return { data: rows, error: null };
      }
      if (st.op === 'update') {
        const hit = db[t].filter(match);
        for (const r of hit) if (violates(t, { ...r, ...st.payload }, r.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        hit.forEach((r) => Object.assign(r, st.payload));
        return { data: hit, error: null };
      }
      if (st.op === 'delete') { const gone = db[t].filter(match); db[t] = db[t].filter((r) => !match(r)); return { data: gone, error: null }; }
      let rows = db[t].filter(match);
      for (const [col, asc] of [...st.order].reverse()) rows = [...rows].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0) * (asc ? 1 : -1));
      const total = rows.length;
      if (st.head) return { data: null, error: null, count: total };
      if (st.lim != null) rows = rows.slice(0, st.lim);
      const out = { data: rows.map((r) => ({ ...r })), error: null };
      if (st.countMode) out.count = total;
      return out;
    };
    const like = (c, v, flags) => {
      const pattern = String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      const re = new RegExp(`^${pattern}$`, flags);
      st.filters.push((r) => re.test(String(r[c] ?? '')));
    };
    const api = {
      select(_cols, opts) { if (opts?.head) st.head = true; if (opts?.count) st.countMode = opts.count; if (st.op !== 'select') st.wantRow = true; return api; },
      eq(c, v) { st.eqs.push([c, v]); st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { st.eqs.push([`is:${c}`, v]); st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, vs) { const list = Array.isArray(vs) ? vs : []; st.ins.push([c, list]); st.filters.push((r) => list.includes(r[c])); return api; },
      gte(c, v) { st.filters.push((r) => String(r[c] ?? '') >= String(v)); return api; },
      gt(c, v) { st.filters.push((r) => String(r[c] ?? '') > String(v)); return api; },
      lte(c, v) { st.filters.push((r) => String(r[c] ?? '') <= String(v)); return api; },
      lt(c, v) { st.filters.push((r) => String(r[c] ?? '') < String(v)); return api; },
      like(c, v) { like(c, v, ''); return api; },
      ilike(c, v) { like(c, v, 'i'); return api; },
      not(c, op, v) {
        if (op === 'is') st.filters.push((r) => (v === null ? r[c] != null : r[c] == null));
        else if (op === 'eq') st.filters.push((r) => r[c] !== v);
        else if (op === 'in') st.filters.push((r) => !(Array.isArray(v) ? v : []).includes(r[c]));
        return api;
      },
      order(c, o = {}) { st.order.push([c, o.ascending !== false]); return api; },
      limit(n) { st.lim = n; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      delete() { st.op = 'delete'; return api; },
      async maybeSingle() { const r = run(); return r.error ? r : { data: (Array.isArray(r.data) ? r.data[0] : r.data) || null, error: null }; },
      async single() { const r = run(); if (r.error) return r; const row = Array.isArray(r.data) ? r.data[0] : r.data; return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } }; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return {
    db, calls,
    from: (t) => q(t),
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }),
    storage: { from: () => ({ download: async (p) => (files[p] ? { data: new Blob([files[p]]), error: null } : { data: null, error: { message: 'not found' } }) }) },
  };
}
