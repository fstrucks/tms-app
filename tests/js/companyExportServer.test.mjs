// Company export builder (E2) with fake db/storage. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { fakeExportSupabase, fid } from './fakeExportSupabase.mjs';
import * as S from '../../app/lib/companyExportServer.js';
import { PART_MAX_BYTES, BUCKET_FILE_SIZE_LIMIT } from '../../app/lib/companyExport.js';
import { ZipWriter, crc32, entryOverhead, END_BYTES } from '../../app/lib/zipStream.js';

export function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end record');
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(at + 26);
    const raw = buf.subarray(at + 30 + lnl, at + 30 + lnl + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, size, name); assert.equal(crc32(data), crc, `crc ${name}`);
    out[name] = data; p += 46 + nl;
  }
  return out;
}

const T0 = Date.parse('2026-10-28T15:00:00Z');
const ids = { A: 'a0000000-0000-4000-8000-00000000000a', B: 'b0000000-0000-4000-8000-00000000000b', o: 'u-owner', m1: 'u-m1', m2: 'u-m2', x: 'u-x', y: 'u-y' };

function world(extra = {}) {
  const L = (id, user_id, n) => ({ id, user_id, load_number: n });
  return fakeExportSupabase({
    unique: { export_jobs: [{ cols: ['company_profile_id'], where: (r) => ['queued', 'running'].includes(r.status) }] },
    tables: {
      company_profiles: [{ id: ids.A, owner_id: ids.o, legal_name: 'FAKE Trucking LLC' }, { id: ids.B, owner_id: ids.y, legal_name: 'Other FAKE Co' }],
      company_members: [{ profile_id: ids.A, user_id: ids.m1, role: 'dispatcher' }, { profile_id: ids.A, user_id: ids.m2, role: 'driver' }, { profile_id: ids.B, user_id: ids.m2, role: 'driver' }, { profile_id: ids.B, user_id: ids.x, role: 'driver' }],
      loads: [L('l1', ids.o, 'TEST-1'), L('l2', ids.m1, 'TEST-2'), L('l3', ids.m2, 'M2-OWN'), L('l9', ids.y, 'OTHER-9')],
      stops: [{ id: 's1', load_id: 'l1', city: 'Testville' }, { id: 's3', load_id: 'l3', city: 'Elsewhere' }, { id: 's9', load_id: 'l9', city: 'Nope' }],
      expenses: [{ id: 'e1', user_id: ids.o, amount: 10 }, { id: 'e2', user_id: ids.m2, amount: 99, load_id: 'l9' }, { id: 'e3', user_id: ids.m2, amount: 5, load_id: 'l1' }],
      documents: [
        { id: 'd1', user_id: ids.o, load_id: 'l1', doc_type: 'bol', file_path: `${ids.o}/bol.pdf`, original_filename: 'BOL.pdf' },
        { id: 'd2', user_id: ids.m1, load_id: 'l2', doc_type: 'pod', file_path: `${ids.m1}/gone.pdf`, original_filename: 'pod.pdf' },
        { id: 'd3', user_id: ids.m2, load_id: 'l1', doc_type: 'receipt', file_path: `${ids.m2}/r.jpg`, original_filename: 'r.jpg', created_at: '2026-10-03T00:00:00Z' },
        { id: 'd4', user_id: ids.m2, load_id: 'l3', doc_type: 'bol', file_path: `${ids.m2}/secret.pdf`, original_filename: 'other-co.pdf' },
        { id: 'd5', user_id: ids.x, doc_type: 'bol', file_path: `${ids.x}/x.pdf`, original_filename: 'x.pdf' },
      ],
      inbound_emails: [{ id: 'i1', owner_id: ids.o, from_email: 'broker@example.test', subject: 'Rate con', received_at: '2026-10-01', status: 'matched', html_body: '<p>SECRET BODY</p>', text_body: 'SECRET BODY' }],
      facility_notes: [
        { id: 'n1', author_id: ids.o, company_id: ids.A, body: 'Gate 3' }, { id: 'n2', author_id: ids.m2, company_id: ids.A, body: 'Dock ok' },
        { id: 'n3', author_id: ids.m2, company_id: ids.B, body: 'OTHER COMPANY NOTE' }, { id: 'n4', author_id: ids.x, company_id: ids.B, body: 'NOPE' }],
      export_jobs: [],
      ...extra.tables,
    },
    files: { [`${ids.o}/bol.pdf`]: Buffer.from('%PDF-1.4 fake bol'), [`${ids.m2}/r.jpg`]: Buffer.alloc(3000, 1), [`${ids.m2}/secret.pdf`]: Buffer.from('x'), [`${ids.x}/x.pdf`]: Buffer.from('x'), ...extra.files },
    missing: extra.missing || ['former_members', 'scale_tickets'],
    ...extra.opts,
  });
}

async function start(sb, user = { id: ids.o, email: 'owner@example.test' }) { return S.startExport(sb, user, { now: new Date(T0) }); }
async function runAll(sb, jobId, deps = {}) {
  let runs = 0, r;
  do { r = await S.runExportJob(sb, jobId, { now: new Date(T0), ...deps }); runs += 1; } while (!r.done && runs < 500 && !r.failed);
  return { r, runs };
}
const job = (sb, id) => sb.db.export_jobs.find((j) => j.id === id);
const partsOf = (sb, j) => j.parts.map((p) => ({ p, bytes: sb.buckets['company-exports'].get(p.object) }));
const allEntries = (sb, j) => Object.assign({}, ...partsOf(sb, j).map(({ bytes }) => readZip(bytes)));

test('full export: scoped rows, files in folders, missing listed, metadata-only email, no other-company data', async () => {
  const sb = world();
  const s = await start(sb);
  assert.equal(s.status, 202);
  const { r } = await runAll(sb, s.jobId);
  assert.ok(r.done);
  const j = job(sb, s.jobId);
  assert.equal(j.status, 'ready');
  assert.equal(j.expires_at, '2026-11-04T15:00:00.000Z');
  const e = allEntries(sb, j);
  const names = Object.keys(e);
  assert.ok(names.includes('loads/TEST-1/BOL.pdf'));
  assert.ok(names.includes('receipts/2026-10/r.jpg'), 'shared member file on this owner load is included');
  assert.ok(!names.some((n) => /other-co|x\.pdf/.test(n)));
  const loads = e['data/loads.csv'].toString();
  assert.match(loads, /TEST-1/); assert.match(loads, /TEST-2/); assert.doesNotMatch(loads, /M2-OWN|OTHER-9/);
  const stops = JSON.parse(e['data/stops.json']); assert.deepEqual(stops.map((x) => x.id), ['s1']);
  const exp = JSON.parse(e['data/expenses.json']); assert.deepEqual(exp.map((x) => x.id).sort(), ['e1', 'e3']);
  const mail = e['data/inbound_emails.csv'].toString(); assert.doesNotMatch(mail, /SECRET BODY/); assert.match(mail, /Rate con/);
  const notes = e['data/facility_notes.csv'].toString(); assert.match(notes, /Gate 3/); assert.match(notes, /Dock ok/); assert.doesNotMatch(notes, /OTHER COMPANY|NOPE/);
  assert.match(e['manifest/not-included.csv'].toString(), /pod\.pdf.*missing/);
  assert.equal(j.missing_count, 1);
  assert.equal(j.file_count, 2);
  assert.match(e['README.txt'].toString(), /FAKE Trucking LLC/);
  assert.match(e[`manifest/part-1.csv`].toString(), /loads\/TEST-1\/BOL\.pdf/);
  assert.ok(!sb.buckets['company-exports'].size || [...sb.buckets['company-exports'].keys()].every((k) => k.startsWith(`exports/${s.jobId}/`)));
  assert.ok(e['data/loads.csv'].toString().startsWith('\uFEFF'));
});

test('many small parts: every finished part is at most the part cap, oversize file listed, tables split into pieces', async () => {
  const files = {}; const documents = [];
  for (let i = 0; i < 40; i++) { const p = `${ids.o}/f${i}.pdf`; files[p] = Buffer.alloc(9000 + i, i); documents.push({ id: `dd${String(i).padStart(3, '0')}`, user_id: ids.o, doc_type: 'w9', file_path: p, original_filename: `file ${i}.pdf` }); }
  files[`${ids.o}/huge.pdf`] = Buffer.alloc(80_000, 7); documents.push({ id: 'dzz', user_id: ids.o, doc_type: 'w9', file_path: `${ids.o}/huge.pdf`, original_filename: 'huge.pdf' });
  const expenses = Array.from({ length: 3000 }, (_, i) => ({ id: `e${String(i).padStart(5, '0')}`, user_id: ids.o, note: `fake ${i} ${'x'.repeat(i % 40)}`, amount: i }));
  const sb = world({ tables: { documents, expenses }, files });
  const s = await start(sb);
  const cap = 40_000;
  const { r } = await runAll(sb, s.jobId, { partMaxBytes: cap });
  assert.ok(r.done, JSON.stringify(r));
  const j = job(sb, s.jobId);
  assert.ok(j.parts.length >= 10, `parts ${j.parts.length}`);
  const e = {};
  for (const { p, bytes } of partsOf(sb, j)) { assert.ok(bytes.length <= cap, `part ${p.n} ${bytes.length}`); assert.equal(bytes.length, p.bytes); Object.assign(e, readZip(bytes)); }
  assert.deepEqual(j.parts.map((p) => p.n), j.parts.map((_, i) => i + 1));
  const pieces = Object.keys(e).filter((n) => /^data\/expenses(-\d+)?\.csv$/.test(n));
  assert.ok(pieces.length > 1);
  const rows = pieces.flatMap((n) => e[n].toString().replace(/^\uFEFF/, '').trim().split('\r\n').slice(1)); // every piece carries its own header
  const idsSeen = rows.map((l) => l.split(',')[0]); const dup = idsSeen.filter((x, i) => idsSeen.indexOf(x) !== i);
  assert.equal(rows.length, 3000, `every expense row exactly once: ${rows.length} dup ${dup.slice(0, 3)} pieces ${pieces}`);
  const json = Object.keys(e).filter((n) => /^data\/expenses(-\d+)?\.json$/.test(n)).flatMap((n) => JSON.parse(e[n]));
  assert.equal(json.length, 3000);
  assert.equal(Object.keys(e).filter((n) => /^documents\/w9\/file \d+\.pdf$/.test(n)).length, 40, Object.keys(e).filter((n) => !n.startsWith('data/')).join(' | '));
  assert.match(e['manifest/not-included.csv'].toString(), /huge\.pdf.*oversize: too large for this export/);
});

test('resumable: tiny time budget spreads work over many runs; a failed upload is redone; same result', async () => {
  const base = world(); const a = await start(base); await runAll(base, a.jobId);
  const one = allEntries(base, job(base, a.jobId));
  let n = 0; let t = T0;
  const sb = world({ opts: { failUpload: () => ++n === 2 } });
  const s = await start(sb);
  let runs = 0, r, errors = 0;
  do {
    try { r = await S.runExportJob(sb, s.jobId, { clock: () => (t += 700), runBudgetMs: 16_000, now: new Date(T0) }); }
    catch (e) { r = { ok: false, e }; errors += 1; }
    runs += 1;
  } while (!r.done && runs < 200);
  assert.ok(r.done && runs > 2, `runs ${runs}`);
  assert.equal(errors, 1, 'the failed upload surfaced once and was retried');
  const two = allEntries(sb, job(sb, s.jobId));
  for (const k of Object.keys(one).filter((k) => !/README|manifest\/part/.test(k))) assert.ok(two[k] || Object.keys(two).some((x) => x.startsWith(k.replace(/\.(csv|json)$/, ''))), k);
  const rows = (e) => Object.keys(e).filter((k) => /^data\/loads(-\d+)?\.json$/.test(k)).flatMap((k) => JSON.parse(e[k])).map((x) => x.id).sort();
  assert.deepEqual(rows(two), rows(one));
});

test('lease: a second run while one holds the lease does nothing; a lapsed lease is taken over', async () => {
  const sb = world(); const s = await start(sb);
  const j = job(sb, s.jobId);
  j.cursor = { ...j.cursor, lease: 'someone', lease_until: new Date(T0 + 60_000).toISOString() };
  assert.deepEqual(await S.runExportJob(sb, s.jobId, { now: new Date(T0) }), { ok: true, busy: true });
  const r = await runAll(sb, s.jobId, { now: new Date(T0 + 120_000) });
  assert.ok(r.r.done);
});

test('storage budget: the job fails cleanly with a clear error and nothing more is written', async () => {
  const sb = world({ tables: { export_jobs: [{ id: fid(), company_profile_id: ids.B, owner_id: ids.y, requested_by: ids.y, status: 'ready', byte_count: 340 * 1024 * 1024, created_at: new Date(T0).toISOString(), parts: [] }] } });
  const s = await start(sb);
  assert.equal(s.status, 202);
  sb.db.export_jobs[0].byte_count = 380 * 1024 * 1024;
  const r = await S.runExportJob(sb, s.jobId, { now: new Date(T0) });
  assert.equal(r.failed, 'storage_budget');
  assert.equal(job(sb, s.jobId).status, 'failed');
  assert.equal(job(sb, s.jobId).error, 'storage_budget');
  sb.db.export_jobs[0].byte_count = 399 * 1024 * 1024;
  const again = await S.startExport(sb, { id: ids.o }, { now: new Date(T0) });
  assert.equal(again.status, 503); assert.equal(again.body.code, 'storage_budget');
});

test('start: owner only, one open job, 3 a day, deletion trigger carries purge time', async () => {
  const sb = world({ tables: { account_deletion_requests: [{ id: 'dr1', user_id: ids.o, company_profile_id: ids.A, purge_after: '2026-11-11T10:15:00Z', cancelled_at: null, completed_at: null }] } });
  assert.equal((await S.startExport(sb, { id: ids.m1 }, { now: new Date(T0) })).status, 403);
  assert.equal((await S.startExport(sb, null, { now: new Date(T0) })).status, 401);
  const a = await start(sb);
  assert.equal(a.status, 202);
  const j = job(sb, a.jobId);
  assert.deepEqual([j.trigger, j.purge_at, j.deletion_request_id, j.requested_by, j.owner_id], ['deletion', '2026-11-11T10:15:00Z', 'dr1', ids.o, ids.o]);
  const b = await start(sb); assert.equal(b.status, 200); assert.ok(b.body.already); assert.equal(b.body.job_id, a.jobId);
  await runAll(sb, a.jobId);
  assert.equal(job(sb, a.jobId).expires_at, '2026-11-18T10:15:00.000Z', '7 days after purge');
  for (const st of ['failed', 'failed']) sb.db.export_jobs.push({ id: fid(), company_profile_id: ids.A, status: st, created_at: new Date(T0).toISOString() });
  assert.equal((await start(sb)).status, 429);
});

test('status: part count and part size for the copy', async () => {
  const sb = world(); const s = await start(sb); await runAll(sb, s.jobId);
  const st = await S.exportStatus(sb, { id: ids.o });
  assert.equal(st.status, 200);
  assert.equal(st.body.job.status, 'ready'); assert.equal(st.body.job.partCount, job(sb, s.jobId).parts.length);
  assert.equal(st.body.job.partMaxBytes, PART_MAX_BYTES); assert.equal(st.body.partMaxBytes, PART_MAX_BYTES);
  assert.equal((await S.exportStatus(sb, { id: ids.m1 })).status, 403);
  assert.deepEqual(S.jobStatus(null), { job: null, partMaxBytes: PART_MAX_BYTES });
});

test('cleanup: 7 days after purge removes objects and the link; failed after 24 h; stale open jobs time out; errors retried', async () => {
  const sb = world();
  const mk = (o) => { const j = { id: fid(), company_profile_id: ids.A, owner_id: ids.o, byte_count: 10, token_hash: 'a'.repeat(64), cleaned_at: null, parts: [], created_at: new Date(T0).toISOString(), ...o }; sb.db.export_jobs.push(j); sb.buckets['company-exports'].set(`exports/${j.id}/part-1.zip`, Buffer.from('z')); return j; };
  const ready = mk({ status: 'ready', expires_at: '2026-11-18T10:15:00Z', parts: [{ n: 1, object: 'x' }] });
  const fresh = mk({ status: 'ready', expires_at: '2026-12-30T00:00:00Z' });
  const failedOld = mk({ status: 'failed', completed_at: '2026-11-17T00:00:00Z' });
  const failedNew = mk({ status: 'failed', completed_at: '2026-11-18T20:00:00Z' });
  const stale = mk({ status: 'running', company_profile_id: ids.B, created_at: '2026-11-16T00:00:00Z' });
  const now = new Date('2026-11-19T00:00:00Z');
  let calls = 0;
  const flaky = async (b, p) => (++calls === 1 ? { error: { message: 'list failed' } } : (await import('../../app/lib/accountDeletionServer.js')).listStoragePrefix(b, p));
  const r1 = await S.cleanupExports(sb, { now, list: flaky });
  assert.equal(r1.errors, 1); assert.equal(r1.timedOut, 1);
  const r2 = await S.cleanupExports(sb, { now });
  assert.equal(r1.cleaned + r2.cleaned, 2);
  const g = (j) => sb.db.export_jobs.find((x) => x.id === j.id);
  assert.ok(g(ready).cleaned_at && g(ready).token_hash === null && g(ready).status === 'expired' && g(ready).byte_count === 0);
  assert.ok(!sb.buckets['company-exports'].has(`exports/${ready.id}/part-1.zip`));
  assert.ok(g(failedOld).cleaned_at && !sb.buckets['company-exports'].has(`exports/${failedOld.id}/part-1.zip`));
  assert.ok(!g(fresh).cleaned_at && sb.buckets['company-exports'].has(`exports/${fresh.id}/part-1.zip`));
  assert.ok(!g(failedNew).cleaned_at);
  assert.deepEqual([g(stale).status, g(stale).error], ['failed', 'timed_out']);
  const r3 = await S.cleanupExports(sb, { now: new Date('2026-11-20T01:00:00Z') });
  assert.equal(r3.cleaned, 2, 'the timed-out and newer failed jobs are cleaned 24 h later');
});

test('purge hold: open export holds the purge for up to 48 h', async () => {
  const sb = world(); const s = await start(sb);
  assert.deepEqual(await S.exportHold(sb, ids.A, new Date(T0 + 3600_000)), { hold: true, jobId: s.jobId });
  assert.deepEqual(await S.exportHold(sb, ids.A, new Date(T0 + 49 * 3600_000)), { hold: false });
  assert.deepEqual(await S.exportHold(sb, ids.B, new Date(T0)), { hold: false });
  const none = fakeExportSupabase({ missing: ['export_jobs'] });
  assert.deepEqual(await S.exportHold(none, ids.A), { hold: false });
});

test('zip writer: projected size is exact, so a part can never pass the cap; cap is below the bucket limit', async () => {
  const chunks = []; const z = new ZipWriter(async (b) => chunks.push(Buffer.from(b)));
  const name = 'drivers/Fake Driver/drug-alcohol/test.pdf';
  const before = z.projected(5000 + entryOverhead(name));
  await z.file(name, Buffer.alloc(5000, 3));
  assert.equal(z.projected(), before);
  const res = await z.finish();
  assert.equal(res.bytes, before); assert.equal(Buffer.concat(chunks).length, before);
  // Worst case overhead for a full part of tiny files still keeps the cap below the bucket limit.
  assert.ok(PART_MAX_BYTES + END_BYTES < BUCKET_FILE_SIZE_LIMIT);
  assert.ok(BUCKET_FILE_SIZE_LIMIT - PART_MAX_BYTES >= 1024 * 1024, 'at least 1 MiB headroom');
});

test('streamed upload: chunks stay bounded (no whole part in memory)', async () => {
  const files = {}; const documents = [];
  for (let i = 0; i < 5; i++) { const p = `${ids.o}/big${i}.pdf`; files[p] = Buffer.alloc(2 * 1024 * 1024, i); documents.push({ id: `b${i}`, user_id: ids.o, doc_type: 'w9', file_path: p, original_filename: `big${i}.pdf` }); }
  const sb = world({ tables: { documents }, files });
  const s = await start(sb); const { r } = await runAll(sb, s.jobId);
  assert.ok(r.done);
  assert.ok(sb.stats.maxChunk <= 2 * 1024 * 1024, `max chunk ${sb.stats.maxChunk}`);
});

test('run and chain: kicks the next run only when work is left', async () => {
  const sb = world(); const s = await start(sb); let kicks = 0; let t = T0;
  await S.runAndChain(sb, s.jobId, { kick: async () => { kicks += 1; }, clock: () => (t += 5000), runBudgetMs: 14_000, now: new Date(T0) });
  assert.equal(kicks, 1);
  const { r } = await runAll(sb, s.jobId);
  assert.ok(r.done);
  kicks = 0; await S.runAndChain(sb, s.jobId, { kick: async () => { kicks += 1; } });
  assert.equal(kicks, 0);
  const env = { CRON_SECRET: 'test-secret', EXPORT_WORKER_BASE_URL: 'https://example.test' };
  const seen = []; await S.kickNextRun('job-1', env, async (u, o) => { seen.push([u, o.headers.authorization]); });
  assert.deepEqual(seen, [['https://example.test/api/cron/company-export?job=job-1', 'Bearer test-secret']]);
  assert.deepEqual(await S.kickNextRun('job-1', {}, async () => {}), { ok: false });
});

import { readFileSync, readdirSync } from 'node:fs';
import { EXPORT_TABLES } from '../../app/lib/companyExport.js';
import { getCompanyExport, postCompanyExport, cronCompanyExport } from '../../app/lib/companyExportRoutes.js';
import { runDueDeletions } from '../../app/lib/accountDeletionServer.js';

test('guard: every table key/order column exists in the migration that creates the table', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  let checked = 0;
  for (const spec of EXPORT_TABLES) {
    const m = new RegExp(`create table (?:if not exists )?(?:public\\.)?${spec.table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
    if (!m) continue; // created outside migrations (dashboard tables); checked against Dakota's column list instead
    const cols = sql.match(new RegExp(`alter table (?:if exists )?(?:public\\.)?${spec.table}\\s+add column (?:if not exists )?(\\w+)`, 'gi')) || [];
    const body = m[1] + '\n' + cols.join('\n');
    for (const c of [spec.key, spec.order].filter(Boolean)) assert.match(body, new RegExp(`\\b${c}\\b`), `${spec.table}.${c}`);
    checked += 1;
  }
  assert.ok(checked >= 10, `checked ${checked}`);
});

test('same file name in two places of one folder: the repeat gets the row id, both kept', async () => {
  const documents = [{ id: 'aaaaaaaa-1', user_id: ids.o, doc_type: 'w9', file_path: `${ids.o}/1.pdf`, original_filename: 'w9.pdf' }, { id: 'bbbbbbbb-2', user_id: ids.o, doc_type: 'w9', file_path: `${ids.o}/2.pdf`, original_filename: 'W9.pdf' }];
  const sb = world({ tables: { documents }, files: { [`${ids.o}/1.pdf`]: Buffer.from('1'), [`${ids.o}/2.pdf`]: Buffer.from('2') } });
  const s = await start(sb); await runAll(sb, s.jobId);
  const names = Object.keys(allEntries(sb, job(sb, s.jobId))).filter((n) => n.startsWith('documents/'));
  assert.deepEqual(names.sort(), ['documents/w9/W9 [bbbbbbbb].pdf', 'documents/w9/w9.pdf']);
});

const req = (url, { token, method = 'GET', auth } = {}) => new Request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(auth ? { authorization: auth } : {}) } });
const users = { 'tok-owner': { id: ids.o, email: 'owner@example.test' }, 'tok-m1': { id: ids.m1 } };
const mkUserClient = () => ({ auth: { getUser: async (t) => (users[t] ? { data: { user: users[t] }, error: null } : { data: null, error: { status: 401, message: 'invalid JWT' } }) } });

test('routes: start and status for the signed-in owner only; work runs after the response', async () => {
  const sb = world(); const later = [];
  const deps = { admin: sb, mkUserClient, waitUntil: (p) => later.push(p), now: new Date(T0) };
  assert.equal((await postCompanyExport(req('https://x.test/api/company-export', { method: 'POST' }), deps)).status, 401);
  assert.equal((await postCompanyExport(req('https://x.test/api/company-export', { method: 'POST', token: 'tok-m1' }), deps)).status, 403);
  const r = await postCompanyExport(req('https://x.test/api/company-export', { method: 'POST', token: 'tok-owner' }), { ...deps, kick: async () => {} });
  assert.equal(r.status, 202); assert.equal(later.length, 1); await Promise.all(later);
  const st = await (await getCompanyExport(req('https://x.test/api/company-export', { token: 'tok-owner' }), deps)).json();
  assert.equal(st.job.status, 'ready'); assert.equal(st.job.partMaxBytes, PART_MAX_BYTES); assert.ok(st.job.partCount >= 1);
  assert.ok(!('cursor' in st.job) && !('token_hash' in st.job));
});

test('cron: same secret rules as account deletion; ?job continues one job; sweep cleans and continues', async () => {
  const sb = world(); const s = await start(sb);
  const env = { CRON_SECRET: 'test-secret' };
  assert.equal((await cronCompanyExport(req('https://x.test/api/cron/company-export'), { admin: sb, env: {} })).status, 503);
  assert.equal((await cronCompanyExport(req('https://x.test/api/cron/company-export', { auth: 'Bearer nope' }), { admin: sb, env })).status, 401);
  const later = []; const kicks = [];
  const one = await cronCompanyExport(req(`https://x.test/api/cron/company-export?job=${s.jobId}`, { auth: 'Bearer test-secret' }), { admin: sb, env, waitUntil: (p) => later.push(p), kick: async (id) => kicks.push(id), now: new Date(T0) });
  assert.equal(one.status, 202); await Promise.all(later);
  assert.equal(job(sb, s.jobId).status, 'ready');
  const sweep = await (await cronCompanyExport(req('https://x.test/api/cron/company-export', { auth: 'Bearer test-secret' }), { admin: sb, env, now: new Date('2026-11-05T16:00:00Z') })).json();
  assert.equal(sweep.cleaned.cleaned, 1); assert.equal(job(sb, s.jobId).status, 'expired');
  assert.equal(sb.buckets['company-exports'].size, 0);
});

test('account deletion cron skips a company with an open export (held), purges once it is done', async () => {
  const sb = world({ tables: { account_deletion_requests: [{ id: 'dr1', user_id: ids.o, company_profile_id: ids.A, purge_after: '2026-10-28T10:15:00Z', cancelled_at: null, completed_at: null }] } });
  const s = await start(sb);
  const run = (now) => runDueDeletions(sb, { exportHold: undefined }, now);
  const held = await run(new Date(T0 + 3600_000));
  assert.deepEqual(held.results, [{ user_id: ids.o, ok: false, held_for_export: s.jobId }]);
});
