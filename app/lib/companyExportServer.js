// Company export builder (PR E2). Server only, service role.
// One run = one claim of the job lease, then ZIP parts are streamed to the private company-exports bucket
// until the run's time budget is used. Progress is saved only after a part upload finishes, so a run that is
// killed or fails is simply redone from the last saved cursor by the next run (uploads use upsert).
// Parts are never larger than PART_MAX_BYTES including every ZIP header (checked before each write).
import {
  EXPORT_BUCKET, EXPORT_TABLES, PART_MAX_BYTES, MANIFEST_COLUMNS, canExport, companyUserIds, csvCell,
  exportExpiresAt, folderFor, isSensitivePath, partObject, pickColumns, rowBelongs, zipPaths,
} from './companyExport.js';
import { ZipWriter, END_BYTES, entryOverhead, streamSink } from './zipStream.js';
import { createHash, randomUUID } from 'node:crypto';

export const RUN_BUDGET_MS = 40_000;            // stop filling parts after this; leaves room under the 60 s limit
export const MIN_LEFT_FOR_NEW_PART_MS = 12_000;
export const LEASE_MS = 90_000;                 // longer than the 60 s function limit, so a dead run's lease lapses
export const MAX_ATTEMPTS = 6;                  // runs that ended without saving progress, then the job fails
export const OPEN_JOB_MAX_MS = 48 * 3600_000;   // purge hold and open-job lifetime
export const FAILED_CLEANUP_MS = 24 * 3600_000; // failed jobs' parts are removed after this
export const EXPORT_STORAGE_BUDGET_BYTES = 400 * 1024 * 1024; // all not-yet-cleaned export objects, every company
export const START_LIMIT_PER_DAY = 3;
export const PAGE_ROWS = 500;
export const IN_CHUNK = 150;
export const MAX_PROBLEM_ROWS = 5000;
const FLUSH_BYTES = 256 * 1024;
const DOCUMENTS_BUCKET = 'documents';
const FILE_SOURCES = [
  { table: 'documents', scope: 'members', key: 'user_id' },
  { table: 'packets', scope: 'owner', key: 'owner_id' },
];
const OPEN = ['queued', 'running'];

const missingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|Could not find the table|schema cache/i.test(e.message || ''));
const notFound = (e) => !!e && (e.statusCode === '404' || e.status === 404 || e.statusCode === 404 || /not.?found|does not exist/i.test(e.message || ''));
const fail = (code) => Object.assign(new Error(code), { code });
// Deflate never grows text by more than this (stored-block headers + sync flush markers).
const deflateBound = (n) => n + 5 * Math.ceil((n + 1) / 16383) + 16;

export const initialCursor = () => ({ v: 1, lease: '', lease_until: null, attempts: 0, phase: 'tables', t: 0, pass: 'csv', chunk: 0, after: null, piece: 1, cols: null, src: 0, part: 1, problems: [], problem_total: 0, counts: {}, skipped_other_company: 0 });

// ---------- membership and row scoping ----------
export async function companyScope(admin, company) {
  const companyId = company.id, ownerId = company.owner_id;
  const mem = await admin.from('company_members').select('profile_id, user_id').eq('profile_id', companyId);
  if (mem.error && !missingTable(mem.error)) throw mem.error;
  const members = (mem.data || []).map((m) => ({ company_profile_id: m.profile_id, user_id: m.user_id }));
  const ids = [...new Set([ownerId, ...members.map((m) => m.user_id)])];
  const all = await admin.from('company_members').select('profile_id, user_id').in('user_id', ids);
  if (all.error && !missingTable(all.error)) throw all.error;
  const owned = await admin.from('company_profiles').select('id, owner_id').in('owner_id', ids);
  if (owned.error) throw owned.error;
  const r = companyUserIds({
    companyId, ownerId, members,
    allMemberships: (all.data || []).map((m) => ({ company_profile_id: m.profile_id, user_id: m.user_id })),
    owned: owned.data || [],
  });
  return { companyId, ownerId, ...r };
}

async function selectIn(admin, table, cols, col, values) {
  const out = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const r = await admin.from(table).select(cols).in(col, values.slice(i, i + IN_CHUNK));
    if (r.error) throw r.error;
    out.push(...(r.data || []));
  }
  return out;
}

// Parent id lists for child scopes, cached for the run.
async function parentIds(admin, scope, kind, cache) {
  if (cache[kind]) return cache[kind];
  let rows;
  if (kind === 'load') rows = (await selectIn(admin, 'loads', 'id, user_id', 'user_id', scope.exclusive)).filter((r) => scope.exclusive.includes(r.user_id));
  else {
    const table = { invoice: 'invoices', service_record: 'service_records', packet: 'packets' }[kind];
    const r = await admin.from(table).select('id').eq('owner_id', scope.ownerId);
    if (r.error && !missingTable(r.error)) throw r.error;
    rows = r.data || [];
  }
  cache[kind] = rows.map((r) => r.id).sort();
  return cache[kind];
}

// Number of "chunks" a table is read in (child scopes read parent ids IN_CHUNK at a time).
async function chunksFor(admin, spec, scope, cache) {
  if (['load', 'invoice', 'service_record', 'packet'].includes(spec.scope)) {
    const ids = await parentIds(admin, scope, spec.scope, cache);
    return { n: Math.ceil(ids.length / IN_CHUNK), ids };
  }
  return { n: 1, ids: null };
}

// One page of rows that belong to the company, plus how many were left out as another company's.
export async function readPage(admin, spec, scope, { chunk = 0, after = null, cache = {}, limit = PAGE_ROWS, columns = '*' } = {}) {
  const order = spec.order || 'id';
  let q = admin.from(spec.table).select(columns);
  if (spec.scope === 'company') q = q.eq(spec.key, scope.companyId);
  else if (spec.scope === 'owner') q = q.eq(spec.key, scope.ownerId);
  else if (spec.scope === 'members' || spec.scope === 'author') q = q.in(spec.key, scope.ids);
  else {
    const { ids } = await chunksFor(admin, spec, scope, cache);
    const part = ids.slice(chunk * IN_CHUNK, (chunk + 1) * IN_CHUNK);
    if (!part.length) return { rows: [], last: null, done: true, skipped: 0 };
    q = q.in(spec.key, part);
  }
  if (after != null) q = q.gt(order, after);
  const r = await q.order(order, { ascending: true }).limit(limit);
  if (r.error) throw r.error;
  const raw = r.data || [];
  let rows = raw;
  if (spec.scope === 'members') {
    const sharedLoads = [...new Set(raw.filter((x) => scope.shared.includes(x[spec.key]) && x.load_id).map((x) => x.load_id))];
    const owners = new Map((sharedLoads.length ? await selectIn(admin, 'loads', 'id, user_id', 'id', sharedLoads) : []).map((l) => [l.id, l.user_id]));
    rows = raw.filter((x) => rowBelongs({ user_id: x[spec.key] }, scope, { loadOwner: spec.table === 'loads' ? x.user_id : owners.get(x.load_id) }));
  } else if (spec.scope === 'author') {
    rows = raw.filter((x) => scope.exclusive.includes(x[spec.key]) || (scope.shared.includes(x[spec.key]) && x.company_id === scope.companyId));
  }
  return { rows, last: raw.length ? raw[raw.length - 1][order] : after, done: raw.length < limit, skipped: raw.length - rows.length };
}

// ---------- jobs, lease, storage budget ----------
export async function exportStorageInUse(admin, { exceptJobId = null } = {}) {
  const r = await admin.from('export_jobs').select('id, byte_count').is('cleaned_at', null);
  if (r.error) throw r.error;
  return (r.data || []).filter((j) => j.id !== exceptJobId).reduce((s, j) => s + (Number(j.byte_count) || 0), 0);
}

async function claim(admin, job, now) {
  const c = job.cursor || initialCursor();
  if (c.lease && c.lease_until && Date.parse(c.lease_until) > +now) return null;
  const lease = randomUUID();
  const attempts = (c.lease ? (c.attempts || 0) + 1 : c.attempts || 0); // a lapsed lease means a run died
  const cursor = { ...initialCursor(), ...c, lease, lease_until: new Date(+now + LEASE_MS).toISOString(), attempts };
  const r = await admin.from('export_jobs').update({ status: 'running', cursor, started_at: job.started_at || now.toISOString() })
    .eq('id', job.id).in('status', OPEN).eq('cursor->>lease', c.lease || '').select('*').maybeSingle();
  if (r.error) throw r.error;
  return r.data ? { job: r.data, lease } : null;
}

async function save(admin, jobId, lease, patch) {
  const r = await admin.from('export_jobs').update(patch).eq('id', jobId).eq('cursor->>lease', lease).select('id').maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) throw fail('lease_lost');
}

async function failJob(admin, job, code, now, lease = null) {
  let q = admin.from('export_jobs').update({ status: 'failed', error: code, completed_at: now.toISOString(), cursor: { ...(job.cursor || {}), lease: '', lease_until: null } }).eq('id', job.id).in('status', OPEN);
  if (lease) q = q.eq('cursor->>lease', lease);
  const r = await q;
  if (r?.error) throw r.error;
  return { ok: false, failed: code };
}

// ---------- one run ----------
export async function runExportJob(admin, jobId, deps = {}) {
  const clock = deps.clock || (() => Date.now());
  const t0 = clock();
  const now = () => new Date(deps.now ? +deps.now + (clock() - t0) : clock());
  const budget = deps.runBudgetMs ?? RUN_BUDGET_MS;
  const partMax = deps.partMaxBytes ?? PART_MAX_BYTES;
  const storageBudget = deps.storageBudgetBytes ?? EXPORT_STORAGE_BUDGET_BYTES;

  const got = await admin.from('export_jobs').select('*').eq('id', jobId).maybeSingle();
  if (got.error) throw got.error;
  let job = got.data;
  if (!job) return { ok: false, missing: true };
  if (!OPEN.includes(job.status)) return { ok: true, done: true, status: job.status };
  if (+now() - Date.parse(job.created_at) > OPEN_JOB_MAX_MS) return failJob(admin, job, 'timed_out', now());
  if ((job.cursor?.attempts || 0) >= MAX_ATTEMPTS) return failJob(admin, job, 'too_many_attempts', now());
  const claimed = await claim(admin, job, now());
  if (!claimed) return { ok: true, busy: true };
  job = claimed.job; const lease = claimed.lease;

  const co = await admin.from('company_profiles').select('*').eq('id', job.company_profile_id).maybeSingle();
  if (co.error) throw co.error;
  if (!co.data || co.data.owner_id !== job.owner_id) return failJob(admin, job, 'company_gone', now(), lease);
  const scope = await companyScope(admin, co.data);
  const cache = {};
  let cur = { ...job.cursor };
  let parts = Array.isArray(job.parts) ? [...job.parts] : [];
  let totals = { file_count: job.file_count || 0, byte_count: job.byte_count || 0, missing_count: job.missing_count || 0 };
  if (!job.member_ids?.length) await save(admin, job.id, lease, { member_ids: scope.ids });
  const docBucket = admin.storage.from(DOCUMENTS_BUCKET);
  const outBucket = admin.storage.from(EXPORT_BUCKET);

  try {
  while (cur.phase !== 'done') {
    if (clock() - t0 > budget - MIN_LEFT_FOR_NEW_PART_MS) break;
    const used = await exportStorageInUse(admin, { exceptJobId: job.id });
    if (used + totals.byte_count + partMax > storageBudget) return failJob(admin, job, 'storage_budget', now(), lease);

    const built = await buildPart(admin, { job, scope, cache, cur, partMax, deadline: t0 + budget, clock, docBucket, outBucket, company: co.data, mkSink: deps.mkSink });
    if (JSON.stringify(built.cursor) === JSON.stringify({ ...cur, part: built.cursor.part })) throw fail('no_progress');
    cur = built.cursor;
    parts = [...parts.filter((p) => p.n !== built.part.n), built.part];
    totals = { file_count: totals.file_count + built.part.files, byte_count: totals.byte_count + built.part.bytes, missing_count: totals.missing_count + built.missing };
    const done = cur.phase === 'done';
    const at = now();
    const patch = { cursor: { ...cur, attempts: 0, lease: done ? '' : lease, lease_until: done ? null : cur.lease_until }, parts, ...totals };
    if (done) Object.assign(patch, { status: 'ready', completed_at: at.toISOString(), expires_at: exportExpiresAt({ purgeAt: job.purge_at, readyAt: at }) });
    await save(admin, job.id, lease, patch);
  }
  } catch (e) {
    // Give the lease back with one more attempt counted so the next run retries from the last saved part.
    if (e?.code !== 'lease_lost') {
      const last = await admin.from('export_jobs').select('cursor').eq('id', job.id).maybeSingle();
      const c = last.data?.cursor || cur;
      await save(admin, job.id, lease, { cursor: { ...c, attempts: (c.attempts || 0) + 1, lease: '', lease_until: null, last_error: String(e?.code || e?.message || 'error').slice(0, 80) } }).catch(() => {});
    }
    throw e;
  }
  if (cur.phase !== 'done') await save(admin, job.id, lease, { cursor: { ...cur, attempts: 0, lease: '', lease_until: null } });
  return { ok: true, done: cur.phase === 'done', parts: parts.length };
}

// Builds and uploads one part. Returns the cursor as of the end of this part.
async function buildPart(admin, { job, scope, cache, cur: start, partMax, deadline, clock, docBucket, outBucket, company, mkSink }) {
  const cur = JSON.parse(JSON.stringify(start));
  const n = cur.part;
  const object = partObject(job.id, n);
  const sink = (mkSink || streamSink)();
  const upload = outBucket.upload(object, sink.readable, { contentType: 'application/zip', upsert: true, duplex: 'half' });
  const zip = new ZipWriter(sink.write);
  const manifest = [];           // rows for this part's own manifest (stored, so its size is exact)
  let manifestBytes = 0;
  const manName = `manifest/part-${n}.csv`;
  const manHeader = '\uFEFF' + MANIFEST_COLUMNS.join(',') + '\r\n';
  const reserve = () => entryOverhead(manName) + Buffer.byteLength(manHeader) + manifestBytes;
  const fits = (bytes, name = '') => zip.projected(bytes + (name ? entryOverhead(name) : 0) + reserve()) <= partMax;
  let files = 0, missing = 0, full = false;
  const time = () => clock() > deadline;
  const problem = (row) => { cur.problem_total += 1; if (cur.problems.length < MAX_PROBLEM_ROWS) cur.problems.push(row); };
  const addManifest = (row) => { const line = MANIFEST_COLUMNS.map((c) => csvCell(row[c])).join(',') + '\r\n'; manifest.push(line); manifestBytes += Buffer.byteLength(line); };
  let uploadErr = null;
  upload.then((r) => { if (r?.error) uploadErr = r.error; }, (e) => { uploadErr = e; });

  try {
    // Tables: CSV pass then JSON pass, paged, split into "-2", "-3" pieces when a part fills or time runs out.
    while (cur.phase === 'tables' && !full && !time()) {
      const spec = EXPORT_TABLES[cur.t];
      if (!spec) { Object.assign(cur, { phase: 'files', src: 0, chunk: 0, after: null }); break; }
      const next = () => (cur.pass === 'csv'
        ? Object.assign(cur, { pass: 'json', chunk: 0, after: null, piece: 1 })
        : Object.assign(cur, { t: cur.t + 1, pass: 'csv', chunk: 0, after: null, piece: 1, cols: null }));
      let chunks;
      try { ({ n: chunks } = await chunksFor(admin, spec, scope, cache)); }
      catch (e) { if (!missingTable(e)) throw e; cur.counts[spec.table] = 'not_in_database'; next(); continue; }
      const name = `data/${spec.file}${cur.piece > 1 ? `-${cur.piece}` : ''}.${cur.pass}`;
      if (!fits(256, name)) { full = true; break; }
      await zip.begin(name, { deflate: true });
      let buf = [], bufBytes = 0, wrote = 0, headerDone = false, entryFull = false, tableDone = false;
      const flush = async () => { if (buf.length) { await zip.data(buf.join('')); buf = []; bufBytes = 0; } };
      if (cur.pass === 'json') { buf.push('['); bufBytes = 1; }
      read: while (!time()) {
        if (cur.chunk >= chunks) { tableDone = true; break; }
        let page;
        try { page = await readPage(admin, spec, scope, { chunk: cur.chunk, after: cur.after, cache }); }
        catch (e) { if (!missingTable(e)) throw e; cur.counts[spec.table] = 'not_in_database'; tableDone = true; break; }
        if (cur.pass === 'csv') cur.skipped_other_company += page.skipped;
        for (const raw of page.rows) {
          const row = pickColumns(spec, raw);
          if (cur.pass === 'csv' && !cur.cols) cur.cols = Object.keys(row);
          let text = cur.pass === 'csv' ? cur.cols.map((c) => csvCell(row[c])).join(',') + '\r\n' : (wrote ? ',\n' : '') + JSON.stringify(row);
          if (cur.pass === 'csv' && !headerDone) { text = '\uFEFF' + cur.cols.map(csvCell).join(',') + '\r\n' + text; }
          const tb = Buffer.byteLength(text);
          if (!fits(deflateBound(bufBytes + tb) + 8)) {
            const alone = deflateBound(tb + 300) + entryOverhead(name) + entryOverhead(manName) + Buffer.byteLength(manHeader) + END_BYTES;
            if (alone > partMax) { // a single row bigger than a whole part: listed, not exported
              problem({ part: '', zip_path: name, bytes: tb, sha256: '', source_table: spec.table, source_id: String(raw.id ?? ''), status: 'oversize: too large for this export' });
              cur.after = raw[spec.order || 'id']; continue;
            }
            entryFull = true; break read;
          }
          buf.push(text); bufBytes += tb; wrote += 1; headerDone = true;
          cur.after = raw[spec.order || 'id'];
          if (cur.pass === 'csv') cur.counts[spec.table] = (Number(cur.counts[spec.table]) || 0) + 1;
          if (bufBytes >= FLUSH_BYTES) await flush();
        }
        if (page.done) { cur.chunk += 1; cur.after = null; }
      }
      if (cur.pass === 'json') buf.push(']');
      await flush(); await zip.end();
      if (tableDone) next();
      else { cur.piece += 1; if (entryFull) full = true; }
    }

    // Files: originals from the documents bucket, in folders.
    while (cur.phase === 'files' && !full && !time()) {
      const src = FILE_SOURCES[cur.src];
      if (!src) { cur.phase = 'final'; break; }
      let page;
      try { page = await readPage(admin, src, scope, { after: cur.after, cache, limit: 50 }); }
      catch (e) { if (missingTable(e)) { cur.src += 1; cur.after = null; continue; } throw e; }
      cur.skipped_other_company += page.skipped;
      const ctx = await folderContext(admin, page.rows);
      let stop = false;
      for (const row of page.rows) {
        if (time()) { stop = true; break; }
        if (!row.file_path) { cur.after = row.id; continue; }
        const folder = folderFor(src.table === 'packets' ? { doc_type: 'packet' } : row, ctx(row));
        const [entry] = zipPaths([{ folder, name: row.original_filename || String(row.file_path).split('/').pop(), file_path: row.file_path }]);
        const zipPath = uniquePath(entry.zipPath, row.id, cur);
        const dl = await docBucket.download(row.file_path);
        if (dl?.error || !dl?.data) {
          if (dl?.error && !notFound(dl.error)) throw dl.error;
          missing += 1; problem({ part: '', zip_path: zipPath, bytes: 0, sha256: '', source_table: src.table, source_id: row.id, status: 'missing' });
          cur.after = row.id; continue;
        }
        const size = dl.data.size;
        if (entryOverhead(zipPath) + size + END_BYTES + entryOverhead(manName) + Buffer.byteLength(manHeader) + 400 > partMax) {
          problem({ part: '', zip_path: zipPath, bytes: size, sha256: '', source_table: src.table, source_id: row.id, status: 'oversize: too large for this export' });
          cur.after = row.id; continue;
        }
        const line = 2 * Buffer.byteLength(zipPath) + 220; // manifest row bound for this file
        if (!fits(size + line, zipPath)) { full = true; stop = true; break; }
        const h = createHash('sha256');
        await zip.begin(zipPath);
        for await (const chunk of dl.data.stream()) { h.update(chunk); await zip.data(chunk); }
        await zip.end();
        addManifest({ part: n, zip_path: zipPath, bytes: size, sha256: h.digest('hex'), source_table: src.table, source_id: row.id, status: isSensitivePath(zipPath) ? 'ok (sensitive)' : 'ok' });
        files += 1; cur.after = row.id;
      }
      if (stop) break;
      if (page.done) { cur.src += 1; cur.after = null; }
    }

    // Final: the list of files that could not be included, and a README. Goes in this part if it fits.
    if (cur.phase === 'final' && !full) {
      const lines = ['\uFEFF' + MANIFEST_COLUMNS.join(',') + '\r\n', ...cur.problems.map((r) => MANIFEST_COLUMNS.map((c) => csvCell(r[c])).join(',') + '\r\n')];
      const notIncluded = lines.join('');
      const readme = readmeText({ company, job, cur, partNumber: n });
      const need = Buffer.byteLength(notIncluded) + Buffer.byteLength(readme);
      if (fits(need + entryOverhead('README.txt'), 'manifest/not-included.csv')) {
        await zip.file('manifest/not-included.csv', Buffer.from(notIncluded, 'utf8'));
        await zip.file('README.txt', Buffer.from(readme, 'utf8'));
        cur.phase = 'done';
      }
    }

    await zip.begin(manName); await zip.data(Buffer.from(manHeader + manifest.join(''), 'utf8')); await zip.end();
    const res = await zip.finish();
    if (res.bytes > partMax) throw fail('part_too_large');
    await sink.close();
    const up = await upload;
    if (up?.error || uploadErr) throw up?.error || uploadErr;
    cur.part = n + 1;
    return { cursor: cur, part: { n, object, bytes: res.bytes, files, entries: res.entries }, missing };
  } catch (e) {
    sink.abort(e);
    await upload.catch(() => {});
    throw e;
  }
}

// Same name in different parts would overwrite when unzipped together, so repeats get the row id.
function uniquePath(p, id, cur) {
  cur.names = cur.names || {};
  const k = createHash('sha1').update(p.toLowerCase()).digest('base64').slice(0, 12);
  const who = String(id).slice(0, 8);
  if (!cur.names[k] || cur.names[k] === who) { cur.names[k] = who; return p; } // same row retried in the next part keeps its name
  const dot = p.lastIndexOf('.');
  const tag = ` [${who}]`;
  return dot > p.lastIndexOf('/') ? p.slice(0, dot) + tag + p.slice(dot) : p + tag;
}

async function folderContext(admin, rows) {
  const loadIds = [...new Set(rows.map((r) => r.load_id).filter(Boolean))];
  const truckIds = [...new Set(rows.map((r) => r.truck_id).filter(Boolean))];
  const driverIds = [...new Set(rows.map((r) => r.driver_id).filter(Boolean))];
  const safeSel = async (t, ids) => { if (!ids.length) return []; try { return await selectIn(admin, t, '*', 'id', ids); } catch (e) { if (missingTable(e)) return []; throw e; } };
  const loads = new Map((await safeSel('loads', loadIds)).map((l) => [l.id, l.load_number || l.reference_number || l.ref_number || null]));
  const trucks = new Map((await safeSel('trucks', truckIds)).map((t) => [t.id, t.unit_number || t.name || null]));
  const drivers = new Map((await safeSel('drivers', driverIds)).map((d) => [d.id, d.full_name || d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || null]));
  return (r) => ({ loadNumber: loads.get(r.load_id) || undefined, unitName: trucks.get(r.truck_id) || undefined, driverName: drivers.get(r.driver_id) || undefined });
}

function readmeText({ company, job, cur, partNumber }) {
  const name = company.legal_name || company.dba_name || 'Company';
  const counts = Object.entries(cur.counts).map(([t, c]) => `  ${t}: ${c}`).join('\r\n');
  return [
    `PowerHaul export for ${name}`,
    `Started ${job.created_at}. This export has ${partNumber} part(s); this README is in the last part.`,
    'Each part is a separate ZIP. Download every part and unzip them into one folder.',
    'data/ holds every table as CSV (opens in Excel or Sheets) and JSON. Large tables are split into -2, -3 pieces.',
    'Original files are in folders (loads, drivers, receipts, maintenance, documents). manifest/part-N.csv lists the files in each part.',
    'manifest/not-included.csv lists files that were missing from storage or too large for this export.',
    'drivers/ and drug-alcohol/ contain sensitive driver records. Store them securely.',
    `Rows per table:\r\n${counts}`,
    cur.problem_total > cur.problems.length ? `${cur.problem_total - cur.problems.length} more files could not be included and are not listed.` : '',
  ].filter(Boolean).join('\r\n') + '\r\n';
}

// ---------- starting and status (owner only) ----------
export async function startExport(admin, user, { now = new Date(), storageBudgetBytes = EXPORT_STORAGE_BUDGET_BYTES, skipDailyLimit = false } = {}) {
  const co = await admin.from('company_profiles').select('id, owner_id, legal_name, dba_name').eq('owner_id', user?.id || '').maybeSingle();
  if (co.error) throw co.error;
  const g = canExport(user, co.data);
  if (!g.ok) return { status: g.status, body: { error: g.error } };
  const recent = await admin.from('export_jobs').select('id, status, created_at').eq('company_profile_id', co.data.id).gte('created_at', new Date(+now - 24 * 3600_000).toISOString());
  if (recent.error) throw recent.error;
  const open = (recent.data || []).find((j) => OPEN.includes(j.status));
  if (open) return { status: 200, body: { ok: true, already: true, job_id: open.id } };
  if (!skipDailyLimit && (recent.data || []).length >= START_LIMIT_PER_DAY) return { status: 429, body: { error: 'You can start up to 3 exports a day. Try again tomorrow.' } };
  if ((await exportStorageInUse(admin)) + PART_MAX_BYTES > storageBudgetBytes) return { status: 503, body: { error: 'Exports are busy right now. Try again later.', code: 'storage_budget' } };
  let deletion = null;
  const dr = await admin.from('account_deletion_requests').select('id, purge_after').eq('user_id', user.id).is('cancelled_at', null).is('completed_at', null).maybeSingle();
  if (!dr.error) deletion = dr.data || null; else if (!missingTable(dr.error)) throw dr.error;
  const ins = await admin.from('export_jobs').insert({
    company_profile_id: co.data.id, owner_id: co.data.owner_id, requested_by: user.id,
    trigger: deletion ? 'deletion' : 'manual', status: 'queued', deliver_to: user.email || null,
    cursor: initialCursor(), parts: [], created_at: now.toISOString(), deletion_request_id: deletion?.id || null, purge_at: deletion?.purge_after || null,
  }).select('id').maybeSingle();
  if (ins.error?.code === '23505') {
    const o = await admin.from('export_jobs').select('id').eq('company_profile_id', co.data.id).in('status', OPEN).maybeSingle();
    return { status: 200, body: { ok: true, already: true, job_id: o.data?.id || null } };
  }
  if (ins.error) throw ins.error;
  console.info('[company-export] started', ins.data.id, deletion ? 'deletion' : 'manual');
  return { status: 202, body: { ok: true, job_id: ins.data.id }, jobId: ins.data.id };
}

export function jobStatus(job) {
  if (!job) return { job: null, partMaxBytes: PART_MAX_BYTES };
  const parts = Array.isArray(job.parts) ? job.parts : [];
  return {
    job: {
      id: job.id, status: job.status, trigger: job.trigger, error: job.error || null,
      partCount: parts.length, partMaxBytes: PART_MAX_BYTES,
      fileCount: job.file_count || 0, missingCount: job.missing_count || 0, byteCount: job.byte_count || 0,
      createdAt: job.created_at, completedAt: job.completed_at || null, expiresAt: job.expires_at || null,
      hasLink: !!job.token_hash, emailedAt: job.cursor?.mail_sent_at || null,
    },
    partMaxBytes: PART_MAX_BYTES,
  };
}

export async function exportStatus(admin, user) {
  const co = await admin.from('company_profiles').select('id, owner_id').eq('owner_id', user?.id || '').maybeSingle();
  if (co.error) throw co.error;
  const g = canExport(user, co.data);
  if (!g.ok) return { status: g.status, body: { error: g.error } };
  const r = await admin.from('export_jobs').select('*').eq('company_profile_id', co.data.id).order('created_at', { ascending: false }).limit(1);
  if (r.error) throw r.error;
  return { status: 200, body: jobStatus((r.data || [])[0] || null) };
}

// ---------- purge hold, cleanup, cron ----------
// The company purge waits while an export is open, for at most 48 h from the job's start.
export async function exportHold(admin, companyProfileId, now = new Date()) {
  if (!companyProfileId) return { hold: false };
  const r = await admin.from('export_jobs').select('id, created_at').eq('company_profile_id', companyProfileId).in('status', OPEN);
  if (r.error) { if (missingTable(r.error)) return { hold: false }; throw r.error; }
  const job = (r.data || []).find((j) => +now - Date.parse(j.created_at) < OPEN_JOB_MAX_MS);
  return job ? { hold: true, jobId: job.id } : { hold: false };
}

async function removeJobObjects(bucket, job, list) {
  const paths = new Set((job.parts || []).map((p) => p.object).filter(Boolean));
  const listed = await list(bucket, `exports/${job.id}`);
  if (listed.error) return { error: listed.error };
  for (const p of listed.paths || []) paths.add(p);
  const all = [...paths];
  for (let i = 0; i < all.length; i += 100) {
    const rm = await bucket.remove(all.slice(i, i + 100));
    if (rm?.error && !notFound(rm.error)) return { error: rm.error };
  }
  return { ok: true, removed: all.length };
}

export async function cleanupExports(admin, { now = new Date(), list } = {}) {
  const lister = list || (await import('./accountDeletionServer.js')).listStoragePrefix;
  const bucket = admin.storage.from(EXPORT_BUCKET);
  const out = { timedOut: 0, cleaned: 0, errors: 0 };
  const stale = await admin.from('export_jobs').select('*').in('status', OPEN).lte('created_at', new Date(+now - OPEN_JOB_MAX_MS).toISOString());
  if (stale.error) throw stale.error;
  for (const j of stale.data || []) { await failJob(admin, j, 'timed_out', now); out.timedOut += 1; }
  const due = await admin.from('export_jobs').select('*').is('cleaned_at', null).in('status', ['ready', 'expired', 'failed']);
  if (due.error) throw due.error;
  for (const j of due.data || []) {
    const expired = j.status !== 'failed' && j.expires_at && Date.parse(j.expires_at) <= +now;
    const failedOld = j.status === 'failed' && j.completed_at && +now - Date.parse(j.completed_at) >= FAILED_CLEANUP_MS;
    if (!expired && !failedOld) continue;
    const rm = await removeJobObjects(bucket, j, lister);
    if (rm.error) { out.errors += 1; continue; }
    const u = await admin.from('export_jobs').update({ cleaned_at: now.toISOString(), token_hash: null, byte_count: 0, ...(expired ? { status: 'expired' } : {}) }).eq('id', j.id).is('cleaned_at', null);
    if (u?.error) { out.errors += 1; continue; }
    out.cleaned += 1;
  }
  return out;
}

// Kicks the next run in a new invocation (the cron route answers at once and works in the background).
export async function kickNextRun(jobId, env = process.env, fetchImpl = fetch) {
  const base = env.EXPORT_WORKER_BASE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '');
  const secret = String(env.CRON_SECRET || '');
  if (!base || !secret) return { ok: false };
  try {
    await fetchImpl(`${base}/api/cron/company-export?job=${encodeURIComponent(jobId)}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) });
    return { ok: true };
  } catch { return { ok: false }; }
}

export async function runAndChain(admin, jobId, deps = {}) {
  let r;
  try { r = await runExportJob(admin, jobId, deps); }
  catch (e) { console.error('[company-export] run', jobId, String(e?.code || e?.message || e).slice(0, 120)); return { ok: false }; }
  if (r.ok && !r.done && !r.busy) await (deps.kick || kickNextRun)(jobId, deps.env || process.env);
  if (r.ok && r.done) {
    try { await (deps.deliver || (await import('./companyExportLink.js')).deliverExport)(admin, jobId, { env: deps.env || process.env, ...(deps.mailDeps || {}) }); }
    catch (e) { console.error('[company-export] mail', jobId, String(e?.code || e?.message || e).slice(0, 120)); }
  }
  return r;
}

// For the deletion confirm flow (E4 calls this; nothing in the UI calls it yet). Starts the owner's export
// for a company, mailed to the owner's sign-in email. The 3-a-day limit does not apply here; the one-open-job rule does.
export async function startExportForDeletion(admin, companyProfileId, { now = new Date(), storageBudgetBytes } = {}) {
  const co = await admin.from('company_profiles').select('id, owner_id').eq('id', companyProfileId || '').maybeSingle();
  if (co.error) throw co.error;
  if (!co.data?.owner_id) return { status: 404, body: { error: 'Company not found.' } };
  const u = await admin.auth.admin.getUserById(co.data.owner_id);
  const email = u?.data?.user?.email || null;
  if (!email) return { status: 409, body: { error: 'The company owner has no email on file.', code: 'no_owner_email' } };
  return startExport(admin, { id: co.data.owner_id, email }, { now, skipDailyLimit: true, ...(storageBudgetBytes ? { storageBudgetBytes } : {}) });
}

// Owner asks for a fresh link (for example the email never came). Replaces the old link.
export async function ownerNewLink(admin, user, { now = new Date(), env = process.env } = {}) {
  const co = await admin.from('company_profiles').select('id, owner_id').eq('owner_id', user?.id || '').maybeSingle();
  if (co.error) throw co.error;
  const g = canExport(user, co.data);
  if (!g.ok) return { status: g.status, body: { error: g.error } };
  const r = await admin.from('export_jobs').select('*').eq('company_profile_id', co.data.id).order('created_at', { ascending: false }).limit(1);
  if (r.error) throw r.error;
  const { issueLink } = await import('./companyExportLink.js');
  const link = await issueLink(admin, (r.data || [])[0], { now, env });
  if (!link.ok) return { status: 409, body: { error: 'There is no finished export to link to.' } };
  if (!link.url) return { status: 503, body: { error: 'Export links aren’t available yet.' } };
  return { status: 200, body: { ok: true, url: link.url } };
}
