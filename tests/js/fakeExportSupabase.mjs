// In-memory Supabase fake for the company export builder: tables with json-path filters
// ("cursor->>lease"), partial unique indexes, and storage buckets that consume streamed uploads.
let seq = 0;
export const fid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const get = (r, c) => { const m = /^(\w+)->>(\w+)$/.exec(c); if (!m) return r[c]; const v = r[m[1]]?.[m[2]]; return v == null ? null : String(v); };

export function fakeExportSupabase({ tables = {}, files = {}, missing = [], unique = {}, failUpload = null, failDownload = null, users = {} } = {}) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => structuredClone(r))]));
  const buckets = { documents: new Map(Object.entries(files)), 'company-exports': new Map() };
  const stats = { uploads: [], maxChunk: 0, removed: [], downloads: 0 };
  const violates = (t, row, self) => (unique[t] || []).some(({ cols, where }) => (!where || where(row)) && (db[t] || []).some((o) => o !== self && (!where || where(o)) && cols.every((c) => o[c] != null && o[c] === row[c])));
  function from(t) {
    const st = { op: 'select', f: [], order: [], lim: null, payload: null, single: false };
    const match = (r) => st.f.every((fn) => fn(r));
    const run = () => {
      if (missing.includes(t)) return { data: null, error: { code: '42P01', message: `relation "${t}" does not exist` } };
      db[t] = db[t] || [];
      let rows;
      if (st.op === 'insert') {
        rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: fid(), created_at: new Date().toISOString(), file_count: 0, byte_count: 0, missing_count: 0, ...structuredClone(r) }));
        for (const r of rows) if (violates(t, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        db[t].push(...rows);
      } else if (st.op === 'update') {
        rows = db[t].filter(match);
        for (const r of rows) if (violates(t, { ...r, ...st.payload }, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        rows.forEach((r) => Object.assign(r, structuredClone(st.payload)));
      } else if (st.op === 'delete') { rows = db[t].filter(match); db[t] = db[t].filter((r) => !match(r)); }
      else {
        rows = db[t].filter(match);
        for (const [c, asc] of [...st.order].reverse()) rows = [...rows].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1));
        if (st.lim != null) rows = rows.slice(0, st.lim);
      }
      const data = rows.map((r) => structuredClone(r));
      if (st.single) { if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }; return { data: data[0] || null, error: null }; }
      return { data, error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { st.f.push((r) => get(r, c) === v); return api; },
      is(c, v) { st.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, vs) { st.f.push((r) => vs.includes(get(r, c))); return api; },
      gt(c, v) { st.f.push((r) => get(r, c) != null && String(get(r, c)) > String(v)); return api; },
      gte(c, v) { st.f.push((r) => get(r, c) != null && String(get(r, c)) >= String(v)); return api; },
      lte(c, v) { st.f.push((r) => get(r, c) != null && String(get(r, c)) <= String(v)); return api; },
      order(c, o = {}) { st.order.push([c, o.ascending !== false]); return api; },
      limit(n) { st.lim = n; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      delete() { st.op = 'delete'; return api; },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  const storage = {
    from(name) {
      const b = buckets[name] || (buckets[name] = new Map());
      return {
        async download(p) {
          stats.downloads += 1;
          if (failDownload?.(p)) return { data: null, error: { status: 500, message: 'upstream error' } };
          if (!b.has(p)) return { data: null, error: { statusCode: '404', message: 'Object not found' } };
          return { data: new Blob([b.get(p)]), error: null };
        },
        async upload(p, body, opts) {
          const chunks = [];
          if (body instanceof ReadableStream) {
            const reader = body.getReader();
            for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); stats.maxChunk = Math.max(stats.maxChunk, value.length); }
          } else chunks.push(Buffer.from(body));
          const buf = Buffer.concat(chunks);
          if (failUpload?.(p, buf)) return { data: null, error: { message: 'upload failed' } };
          if (name === 'company-exports' && buf.length > 47185920) return { data: null, error: { statusCode: '413', message: 'Payload too large' } };
          if (b.has(p) && !opts?.upsert) return { data: null, error: { message: 'The resource already exists' } };
          b.set(p, buf); stats.uploads.push({ p, bytes: buf.length });
          return { data: { path: p }, error: null };
        },
        async createSignedUrl(p, secs, opts) {
          if (!b.has(p)) return { data: null, error: { statusCode: '404', message: 'Object not found' } };
          stats.signed = (stats.signed || 0) + 1;
          return { data: { signedUrl: `https://storage.example.test/sign/${name}/${p}?expires=${secs}&download=${encodeURIComponent(opts?.download || '')}` }, error: null };
        },
        async remove(paths) { for (const p of paths) { b.delete(p); stats.removed.push(p); } return { data: paths, error: null }; },
        async list(dir, { limit = 1000, offset = 0 } = {}) {
          const pre = dir ? `${dir}/` : '';
          const names = new Map();
          for (const k of b.keys()) if (k.startsWith(pre)) { const rest = k.slice(pre.length); const [head, ...more] = rest.split('/'); names.set(head, more.length ? null : { size: b.get(k).length }); }
          const items = [...names].map(([n, m]) => (m ? { name: n, id: n, metadata: m } : { name: n, id: null, metadata: null }));
          return { data: items.slice(offset, offset + limit), error: null };
        },
      };
    },
  };
  const auth = { admin: { async getUserById(id) { const u = (users || {})[id]; return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { status: 404, message: 'User not found' } }; } } };
  return { from, storage, auth, db, buckets, stats };
}
