// Company export before delete, PR E1 planner. Pure; fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as X from '../../app/lib/companyExport.js';
import { DRIVER_VAULT_TYPE_IDS } from '../../app/lib/driverVault.js';
import { CHECKLIST_ITEMS } from '../../app/lib/setupCatalog.js';

const MIG = new URL('../../supabase/migrations/', import.meta.url).pathname;
const created = new Set();
for (const f of readdirSync(MIG)) for (const m of readFileSync(MIG + f, 'utf8').replace(/--.*$/gm, '').matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)/gi)) created.add(m[1]);

test('every table created in migrations is either exported or excluded with a reason', () => {
  const decided = new Set([...X.EXPORT_TABLES.map((t) => t.table), ...Object.keys(X.EXCLUDED_TABLES)]);
  const missing = [...created].filter((t) => !decided.has(t));
  assert.deepEqual(missing, [], `decide export or exclude for: ${missing.join(', ')}`);
  for (const t of X.EXPORT_TABLES) assert.ok(!(t.table in X.EXCLUDED_TABLES), `${t.table} both exported and excluded`);
});

test('core records Marc listed are in the export', () => {
  const names = X.EXPORT_TABLES.map((t) => t.table);
  for (const t of ['loads', 'documents', 'drivers', 'service_records', 'expenses', 'mileage_entries', 'invoices', 'facility_notes', 'facility_reviews']) assert.ok(names.includes(t), t);
  assert.equal(X.EXPORT_TABLES.find((t) => t.table === 'facility_reviews').scope, 'author');
  assert.equal(X.EXPORT_TABLES.find((t) => t.table === 'facility_notes').scope, 'author');
  assert.ok(!names.includes('facilities'));
});

test('older tables use user_id (prod has no company column); stops go through loads', () => {
  const by = Object.fromEntries(X.EXPORT_TABLES.map((t) => [t.table, t]));
  for (const t of ['loads', 'expenses', 'mileage_entries', 'trucks', 'trailers']) assert.deepEqual([by[t].scope, by[t].key], ['members', 'user_id'], t);
  assert.deepEqual([by.stops.scope, by.stops.key], ['load', 'load_id']);
});

test('inbound emails are metadata only (no body columns)', () => {
  const spec = X.EXPORT_TABLES.find((t) => t.table === 'inbound_emails');
  assert.ok(spec.columns && !spec.columns.some((c) => /body|html|text|raw|attachment/.test(c)));
  assert.deepEqual(X.pickColumns(spec, { id: 1, subject: 'FAKE', html_body: '<p>x</p>', raw: 'x' }), { id: 1, subject: 'FAKE' });
});

test('drug/alcohol and driver file types match the app', () => {
  for (const id of DRIVER_VAULT_TYPE_IDS) assert.ok(X.DRUG_ALCOHOL_TYPES.includes(id) || X.DRIVER_FILE_TYPES.includes(id), `driver vault type ${id} has no folder rule`);
  for (const i of CHECKLIST_ITEMS) if (i.category === 'drug_alcohol' && i.docType) assert.ok(X.DRUG_ALCOHOL_TYPES.includes(i.docType), i.docType);
});

test('folders', () => {
  assert.equal(X.folderFor({ doc_type: 'drug_test' }, { driverName: 'Fake Driver' }), 'drivers/Fake Driver/drug-alcohol');
  assert.equal(X.folderFor({ doc_type: 'da_policy' }), 'drug-alcohol');
  assert.equal(X.folderFor({ doc_type: 'cdl' }, { driverName: 'Fake Driver' }), 'drivers/Fake Driver');
  assert.equal(X.folderFor({ doc_type: 'receipt', created_at: '2026-10-03T00:00:00Z' }), 'receipts/2026-10');
  assert.equal(X.folderFor({ doc_type: 'bol', load_id: 'abc' }, { loadNumber: 'TEST-123' }), 'loads/TEST-123');
  assert.equal(X.folderFor({ doc_type: 'other' }, { unitName: 'Truck 1' }), 'maintenance/Truck 1');
  assert.equal(X.folderFor({ doc_type: 'w9' }), 'documents/w9');
  assert.equal(X.folderFor({ doc_type: 'bol', load_id: 'abcdef1234' }, { loadNumber: '../../etc' }), 'loads/etc');
  assert.ok(X.isSensitivePath('drivers/x/cdl.pdf') && X.isSensitivePath('drug-alcohol/p.pdf') && !X.isSensitivePath('loads/x.pdf'));
});

test('zip paths are unique and safe', () => {
  const r = X.zipPaths([{ folder: 'loads/A', name: 'BOL.pdf' }, { folder: 'loads/A', name: 'bol.PDF' }, { folder: 'loads/A', name: '../../x.pdf' }, { folder: 'loads/A', name: '', file_path: 'u/abc.jpg' }]);
  assert.deepEqual(r.map((e) => e.zipPath), ['loads/A/BOL.pdf', 'loads/A/bol (2).pdf', 'loads/A/x.pdf', 'loads/A/file.jpg']);
  for (const e of r) assert.ok(!e.zipPath.split('/').includes('..'));
});

test('parts split at 45 MB', () => {
  const MB = 1024 * 1024;
  assert.equal(X.PART_MAX_BYTES, 47185920);
  const files = Array.from({ length: 100 }, (_, i) => ({ id: i, bytes: MB }));
  const parts = X.splitParts(files);
  assert.deepEqual(parts.map((p) => p.files.length), [45, 45, 10]);
  for (const p of parts) assert.ok(p.bytes <= X.PART_MAX_BYTES);
  assert.equal(X.splitParts(files, { reserve: 5 * MB })[0].files.length, 40, 'data files reserve room in part 1');
  assert.deepEqual(X.splitParts([]).map((p) => p.files.length), [0], 'empty export still has one part');
  const big = X.splitParts([{ bytes: 1 }, { bytes: 600 * MB }, { bytes: 1 }]);
  assert.equal(big.length, 3); assert.ok(big[1].oversize);
});

test('plan: part names, objects, manifest, sensitive count', () => {
  const p = X.planExport({ jobId: 'job-1', companyName: 'FAKE Trucking LLC', at: '2026-10-28T15:00:00Z',
    documents: [{ id: 'd1', doc_type: 'bol', load_id: 'L', bytes: 100, original_filename: 'bol.pdf' }, { id: 'd2', doc_type: 'drug_test', bytes: 50, original_filename: 't.pdf' }],
    ctxFor: (d) => (d.id === 'd2' ? { driverName: 'Fake D' } : { loadNumber: 'T1' }) });
  assert.equal(p.parts.length, 1);
  assert.equal(p.parts[0].name, 'PowerHaul-export-FAKE-Trucking-LLC-2026-10-28-part1of1.zip');
  assert.equal(p.parts[0].object, 'exports/job-1/part-1.zip');
  assert.equal(p.sensitiveFiles, 1);
  assert.ok(p.tables.find((t) => t.table === 'inbound_emails').metadataOnly);
  assert.deepEqual(Object.keys(X.manifestRow(p.parts[0].files[0], 1)), X.MANIFEST_COLUMNS);
});

test('csv: quoting, BOM, formula guard', () => {
  const s = X.toCsv([{ a: 'x,y', b: '=SUM(A1)', c: null, d: { k: 1 } }]);
  assert.ok(s.startsWith('\uFEFFa,b,c,d\r\n'));
  assert.ok(s.includes('"x,y",\'=SUM(A1),,"{""k"":1}"'));
});

test('owner-only guard', () => {
  const co = { id: 'c1', owner_id: 'u1' };
  assert.deepEqual(X.canExport({ id: 'u1' }, co), { ok: true });
  assert.equal(X.canExport({ id: 'u2' }, co).status, 403);
  assert.equal(X.canExport(null, co).status, 401);
  assert.equal(X.canExport({ id: 'u1' }, null).ok, false);
  assert.equal(X.canExport({ id: 'u1' }, { id: 'c1' }).ok, false);
});

test('company user ids from membership; multi-company members are flagged shared', () => {
  const r = X.companyUserIds({ companyId: 'A', ownerId: 'o', members: [{ company_profile_id: 'A', user_id: 'm1' }, { company_profile_id: 'A', user_id: 'm2' }, { company_profile_id: 'B', user_id: 'x' }],
    allMemberships: [{ user_id: 'm2', company_profile_id: 'B' }, { user_id: 'm1', company_profile_id: 'A' }], owned: [{ id: 'C', owner_id: 'm1' }] });
  assert.deepEqual(r.ids, ['o', 'm1', 'm2']);
  assert.deepEqual(r.shared, ['m1', 'm2']);
  assert.deepEqual(r.exclusive, ['o']);
  assert.ok(X.rowBelongs({ user_id: 'o' }, { ...r, ownerId: 'o' }));
  assert.ok(X.rowBelongs({ user_id: 'm2' }, { ...r, ownerId: 'o' }, { loadOwner: 'o' }));
  assert.ok(!X.rowBelongs({ user_id: 'm2' }, { ...r, ownerId: 'o' }), 'shared member row with no link to this company is left out');
  assert.ok(!X.rowBelongs({ user_id: 'zz' }, { ...r, ownerId: 'o' }));
  assert.ok(!X.rowBelongs({}, { ...r, ownerId: 'o' }));
});

test('link token: random, only the hash is kept, constant-time compare', () => {
  const a = X.newLinkToken(), b = X.newLinkToken();
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.hash, X.hashToken(a.token));
  assert.ok(X.tokenMatches(a.token, a.hash));
  assert.ok(!X.tokenMatches(b.token, a.hash));
  assert.ok(!X.tokenMatches('short', a.hash));
  assert.ok(!X.tokenMatches(a.token, null));
  assert.ok(!X.tokenMatches(a.hash, a.hash));
});

test('expiry: 7 days after purge, else 7 days after ready; link state and cleanup', () => {
  assert.equal(X.exportExpiresAt({ purgeAt: '2026-11-11T10:15:00Z' }), '2026-11-18T10:15:00.000Z');
  assert.equal(X.exportExpiresAt({ readyAt: '2026-10-28T00:00:00Z' }), '2026-11-04T00:00:00.000Z');
  assert.equal(X.exportExpiresAt({ purgeAt: 'nope' }), null);
  const now = new Date('2026-11-15T00:00:00Z');
  const job = { status: 'ready', expires_at: '2026-11-18T10:15:00Z' };
  assert.equal(X.linkState(job, now), 'ready');
  assert.equal(X.linkState({ ...job, status: 'running' }, now), 'preparing');
  assert.equal(X.linkState(job, new Date('2026-11-19T00:00:00Z')), 'expired');
  assert.equal(X.linkState({ ...job, cleaned_at: '2026-11-18' }, now), 'expired');
  assert.equal(X.linkState(null), 'missing');
  assert.ok(X.needsCleanup(job, new Date('2026-11-19T00:00:00Z')) && !X.needsCleanup(job, now));
  assert.ok(!X.needsCleanup({ ...job, cleaned_at: 'x' }, new Date('2030-01-01')));
});

test('export emails are outside the monthly cap; bucket constant matches the migration', () => {
  assert.equal(X.COUNTS_TOWARD_SEND_CAP, false);
  const sql = readFileSync(MIG + '20261028000400_company_exports.sql', 'utf8');
  assert.ok(sql.includes(`'${X.EXPORT_BUCKET}'`) && sql.includes(String(X.BUCKET_FILE_SIZE_LIMIT)) && X.PART_MAX_BYTES < X.BUCKET_FILE_SIZE_LIMIT);
});
