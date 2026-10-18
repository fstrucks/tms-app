// PR #84 Company Documents vault (Marc's picks 1A, 2C, 3A, 4A, 5B, 6A + Taylor's notes). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { groupVault, vaultForRole, vaultStatus, coiExpiry, canOpenVaultFile, canManageVault, checkVaultUpload, checkSendSize, encodedSize,
  sendAttachmentOptions, deleteCurrentPrompt, vaultPath, isVaultPathFor, MAX_VAULT_FILE_BYTES, VAULT_TYPE_IDS } from '../../app/lib/companyDocs.js';
import { isDocumentsTabDoc, UPLOAD_TYPES, CHANGE_TYPES, DOCUMENTS_SCAN_TYPE_IDS, isCompanyDocType } from '../../app/lib/docTypes.js';
import { asPdf } from '../../app/lib/vaultSend.js';
import { deleteLoad } from '../../app/lib/loadDelete.js';
import * as VAULT from '../../app/api/company/documents/route.js';
import * as SEND from '../../app/api/packets/[id]/send/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const OWNER = 'owner1';
const TODAY = '2026-10-18';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const doc = (n, type, created, o = {}) => ({ id: id(n), user_id: OWNER, doc_type: type, file_path: `${OWNER}/company/vault-${type}-${n}-FAKE.pdf`, original_filename: `${type.toUpperCase()}_DemoCarrier_FAKE_${n}.pdf`, created_at: created, load_id: null, ...o });
const DOCS = () => [
  doc(1, 'w9', '2026-01-05T10:00:00Z'), doc(2, 'w9', '2026-10-01T10:00:00Z'),
  doc(3, 'coi', '2026-10-02T10:00:00Z'), doc(4, 'mc_authority', '2026-09-01T10:00:00Z'), doc(5, 'noa', '2026-10-03T10:00:00Z'),
  { ...doc(9, 'rate_confirmation', '2026-10-04T10:00:00Z') },
];
const POLICIES = [
  { owner_id: OWNER, coverage: 'auto_liability', limit_amount: 1000000, expiry_date: '2027-03-01', confirmed: true },
  { owner_id: OWNER, coverage: 'cargo', limit_amount: 100000, expiry_date: '2027-02-01', confirmed: true },
];

test('1A: newest upload is current; deleting it makes the previous version current again (Taylor)', () => {
  const g = groupVault(DOCS());
  assert.deepEqual(g.map((x) => x.type), ['w9', 'coi', 'mc_authority', 'noa']);
  assert.equal(g[0].current.id, id(2)); assert.deepEqual(g[0].earlier.map((d) => d.id), [id(1)]);
  const after = groupVault(DOCS().filter((d) => d.id !== id(2)));
  assert.equal(after[0].current.id, id(1));
  assert.match(deleteCurrentPrompt(g[0], () => 'Jan 5'), /previous version \(uploaded Jan 5\) becomes current again/);
  assert.match(deleteCurrentPrompt(g[1]), /show as missing/);
});

test('2C: roles. Owner/management manage + open all; dispatcher/driver open COI and MC only', () => {
  for (const r of ['owner', 'management']) { assert.equal(canManageVault(r), true); for (const t of VAULT_TYPE_IDS) assert.equal(canOpenVaultFile(r, t), true, `${r} ${t}`); }
  for (const r of ['dispatcher', 'driver']) {
    assert.equal(canManageVault(r), false);
    assert.equal(canOpenVaultFile(r, 'w9'), false); assert.equal(canOpenVaultFile(r, 'noa'), false);
    assert.equal(canOpenVaultFile(r, 'coi'), true); assert.equal(canOpenVaultFile(r, 'mc_authority'), true);
  }
  assert.equal(canOpenVaultFile('owner', 'rate_confirmation'), false);
});

test('2C: vaultForRole strips W-9 and NOA to on-file status only for dispatcher/driver', () => {
  const g = groupVault(DOCS());
  for (const role of ['driver', 'dispatcher']) {
    const v = vaultForRole(g, role, { policies: POLICIES, today: TODAY });
    const w9 = v.find((x) => x.type === 'w9'), noa = v.find((x) => x.type === 'noa');
    for (const r of [w9, noa]) {
      assert.equal(r.restricted, true); assert.equal(r.onFile, true);
      assert.deepEqual(Object.keys(r).sort(), ['label', 'onFile', 'restricted', 'status', 'type']);
      assert.deepEqual(Object.keys(r.status).sort(), ['level', 'text']);
    }
    const blob = JSON.stringify([w9, noa]);
    assert.doesNotMatch(blob, /W9_DemoCarrier|NOA_DemoCarrier|vault-|00000000-/);
    assert.equal(v.find((x) => x.type === 'coi').current.id, id(3));
  }
  const own = vaultForRole(g, 'management', { policies: POLICIES, today: TODAY });
  assert.equal(own.find((x) => x.type === 'w9').current.id, id(2));
  assert.equal(own.find((x) => x.type === 'w9').earlier.length, 1);
});

test('3A + statuses: COI expiry from confirmed auto/cargo; expired red, ≤30 days amber; W-9 year-old hint', () => {
  assert.equal(coiExpiry(POLICIES), '2027-02-01');
  assert.equal(coiExpiry([...POLICIES, { coverage: 'cargo', expiry_date: '2026-01-01', confirmed: false }]), '2027-02-01');
  const g = groupVault(DOCS());
  const coi = g.find((x) => x.type === 'coi');
  assert.equal(vaultStatus(coi, { policies: POLICIES, today: TODAY }).level, 'ok');
  assert.equal(vaultStatus(coi, { policies: POLICIES, today: '2027-01-10' }).level, 'warn');
  const exp = vaultStatus(coi, { policies: POLICIES, today: '2027-02-05' });
  assert.equal(exp.level, 'bad'); assert.equal(exp.text, 'Expired');
  assert.equal(vaultStatus(coi, { policies: [], today: TODAY }).level, 'bad'); // coverage missing
  assert.equal(vaultStatus({ type: 'noa', current: null }, {}).text, 'Missing');
  assert.equal(vaultStatus(g[1 - 1], { today: TODAY }).hint, null);
  assert.match(vaultStatus({ type: 'w9', current: doc(1, 'w9', '2025-09-01T00:00:00Z') }, { today: TODAY }).hint, /over a year old/);
  assert.equal(vaultStatus(g.find((x) => x.type === 'mc_authority'), { today: TODAY }).expiryText, 'No expiry');
});

test('Size (Taylor): Postmark counts encoded size; files capped at 7.5 MB raw ≈ 10 MB encoded', () => {
  assert.equal(encodedSize(3), 4); assert.equal(encodedSize(7_500_000), 10_000_000);
  assert.equal(checkSendSize([1_000_000, 6_400_000]).ok, true);
  assert.equal(checkSendSize([7_500_000]).ok, true);
  const big = checkSendSize([1_000_000, 6_600_000]);
  assert.equal(big.ok, false); assert.match(big.error, /7\.6 MB.*10\.1 MB once encoded.*Nothing was sent/);
  assert.equal(checkVaultUpload({ size: MAX_VAULT_FILE_BYTES, contentType: 'application/pdf' }), null);
  assert.match(checkVaultUpload({ size: MAX_VAULT_FILE_BYTES + 1, contentType: 'application/pdf' }), /limit is 7\.5 MB/);
  assert.match(checkVaultUpload({ size: 10, contentType: 'image/heic' }), /PDF, JPEG or PNG/);
});

test('4A: a flagged/expired COI starts unticked with a warning; missing docs are not offered', () => {
  const g = groupVault(DOCS().filter((d) => d.doc_type !== 'noa'));
  const o = sendAttachmentOptions(g, { policies: POLICIES, today: '2027-03-05' });
  const coi = o.find((x) => x.type === 'coi');
  assert.equal(coi.checked, false); assert.match(coi.warning, /unticked; you can still send it/);
  assert.equal(o.find((x) => x.type === 'w9').checked, true);
  assert.equal(o.find((x) => x.type === 'noa').available, false);
  assert.deepEqual(o.filter((x) => x.available).map((x) => x.filename), ['W-9.pdf', 'COI.pdf', 'MC-Authority.pdf']); // 6A: separate PDFs
});

test('paths: new vault files always go under the OWNER folder', () => {
  const p = vaultPath(OWNER, 'w9', 'my w9 (FAKE).pdf', 1);
  assert.equal(p, 'owner1/company/vault-w9-1-my_w9__FAKE_.pdf');
  assert.equal(isVaultPathFor(OWNER, 'w9', p), true);
  assert.equal(isVaultPathFor('other', 'w9', p), false);
  assert.equal(isVaultPathFor(OWNER, 'noa', p), false);
  assert.equal(isVaultPathFor(OWNER, 'w9', 'owner1/company/vault-w9-../../x'), false);
});

test('Documents tab = load paperwork only; Change type can still move a file into the vault', () => {
  assert.equal(isCompanyDocType('noa'), true);
  assert.equal(isDocumentsTabDoc({ doc_type: 'coi' }), false); assert.equal(isDocumentsTabDoc({ doc_type: 'bol' }), true); assert.equal(isDocumentsTabDoc({ doc_type: null }), true);
  assert.ok(!UPLOAD_TYPES.some((t) => isCompanyDocType(t.id)));
  assert.ok(!DOCUMENTS_SCAN_TYPE_IDS.some(isCompanyDocType));
  assert.ok(['w9', 'coi', 'mc_authority', 'noa'].every((t) => CHANGE_TYPES.some((x) => x.id === t)));
  const page = read('app/documents/page.js');
  assert.match(page, /setDocs\(\(data \|\| \[\]\)\.filter\(isDocumentsTabDoc\)\)/);
  assert.match(page, /data-testid="vault-note"/);
});

test('load delete never deletes company docs, only unlinks them', async () => {
  const calls = [];
  const sb = { from: (t) => ({
    update: (p) => ({ eq: async (c, v) => { calls.push(['update', t, v]); return { error: null }; } }),
    delete: () => ({ eq: (c, v) => { const pr = { select: async () => { calls.push(['delete', t, v]); return { data: [{ id: v }], error: null }; } }; pr.then = (a, b) => { calls.push(['delete', t, v]); return Promise.resolve({ error: null }).then(a, b); }; return pr; } }),
  }), storage: { from: () => ({ remove: async (p) => { calls.push(['storage', p[0]]); return { error: null }; } }) } };
  const r = await deleteLoad(sb, 'L1', { deleteDocs: true, docs: [{ id: 'd-bol', doc_type: 'bol', file_path: 'u/b.pdf' }, { id: 'd-coi', doc_type: 'coi', file_path: 'u/c.pdf' }] });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'update' && c[1] === 'documents' && c[2] === 'd-coi'));
  assert.ok(!calls.some((c) => c[0] === 'delete' && c[2] === 'd-coi'));
  assert.ok(!calls.some((c) => c[0] === 'storage' && c[1] === 'u/c.pdf'));
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === 'documents' && c[2] === 'd-bol'));
});

test('asPdf: PDFs pass through; PNG becomes a one-page PDF; other bytes refused', async () => {
  const pdf = new Uint8Array(Buffer.from('%PDF-1.4 fake'));
  assert.equal(await asPdf(pdf), pdf);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const out = await asPdf(new Uint8Array(png));
  assert.equal(Buffer.from(out.slice(0, 4)).toString(), '%PDF');
  assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
  assert.equal(await asPdf(new Uint8Array(Buffer.from('GIF89a'))), null);
});

// ---------- route tests with a fake Supabase ----------
function fakeDb({ docs = DOCS(), policies = POLICIES, sendsHasColumn = true, objects = null, packet = null } = {}) {
  const tbl = { documents: docs, insurance_policies: policies, company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'Demo Carrier (FAKE)' }],
    packets: packet ? [packet] : [], packet_sends: [], coi_requests: [] };
  const files = objects || Object.fromEntries(docs.map((d) => [d.file_path, Buffer.from('%PDF-1.4 vault fake ' + d.id)]));
  if (packet?.filled_path) files[packet.filled_path] = files[packet.filled_path] || Buffer.from('%PDF-1.4 packet fake');
  const log = [];
  const from = (name) => {
    const st = { op: 'select', f: [], inF: null };
    const run = () => {
      const rows = (tbl[name] || []).filter((r) => st.f.every(([k, v]) => r[k] === v) && (!st.inF || st.inF[1].includes(r[st.inF[0]])) && (!st.g || String(r[st.g[0]]) >= st.g[1]));
      if (st.op === 'insert') {
        if (name === 'packet_sends' && !sendsHasColumn && 'attached_document_ids' in st.payload) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'attached_document_ids' column of 'packet_sends'" } };
        const row = { id: st.payload.id || id(100 + tbl[name].length), created_at: new Date().toISOString(), sent_at: new Date().toISOString(), ...st.payload };
        tbl[name].push(row); log.push(['insert', name, row]);
        return { data: st.one ? { id: row.id } : [row], error: null };
      }
      if (st.op === 'delete') { tbl[name] = tbl[name].filter((r) => !rows.includes(r)); log.push(['delete', name, rows.map((r) => r.id)]); return { data: rows.map((r) => ({ id: r.id })), error: null }; }
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { error: null }; }
      if (st.head) return { count: rows.length, data: null, error: null };
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = { select(_c, o) { if (o?.head) st.head = true; return b; }, eq(k, v) { st.f.push([k, v]); return b; }, in(k, v) { st.inF = [k, v]; return b; }, gte(k, v) { st.g = [k, v]; return b; },
      order() { return b; }, limit() { return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; }, update(p) { st.op = 'update'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, single: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) };
    return b;
  };
  const storage = { from: () => ({
    download: async (p) => (files[p] ? { data: new Blob([files[p]]) } : { data: null }),
    list: async (dir, { search }) => { const p = `${dir}/${search}`; return { data: files[p] ? [{ name: search, metadata: { size: files[p].length } }] : [] }; },
    createSignedUrl: async (p) => ({ data: { signedUrl: `https://fake.storage/${p}?sig=FAKE` } }),
    createSignedUploadUrl: async (p) => ({ data: { path: p, token: 'fake-upload-token' } }),
    remove: async (ps) => { ps.forEach((p) => delete files[p]); log.push(['remove', ps]); return { error: null }; },
  }) };
  return { from, storage, tbl, files, log };
}
const ucFor = (role, db) => () => ({ auth: { getUser: async () => ({ data: { user: { id: role === 'owner' ? OWNER : 'u-' + role } } }) }, rpc: async () => ({ data: role }),
  from: (t) => (t === 'company_profiles' ? db.from(t) : db.from(t)), storage: db.storage });
const vreq = (method, { qs = '', body } = {}) => new Request(`http://x/api/company/documents${qs}`, { method, headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const deps = (role, db) => ({ mkUserClient: ucFor(role, db), sb: db, today: TODAY, now: () => 1 });

test('GET /api/company/documents: driver response has no W-9/NOA file details (server-side 2C)', async () => {
  const db = fakeDb();
  const res = await VAULT.GET(vreq('GET'), { deps: deps('driver', db) });
  assert.equal(res.status, 200);
  const txt = await res.text(); const j = JSON.parse(txt);
  assert.equal(j.canManage, false);
  assert.doesNotMatch(txt, /W9_DemoCarrier|NOA_DemoCarrier|vault-w9|vault-noa/);
  assert.match(txt, /COI_DemoCarrier/);
  assert.equal(j.vault.find((r) => r.type === 'w9').status.text, 'On file');
  const m = await (await VAULT.GET(vreq('GET'), { deps: deps('management', db) })).json();
  assert.equal(m.canManage, true); assert.equal(m.vault.find((r) => r.type === 'w9').current.id, id(2));
});

test('GET ?view=: W-9/NOA file URL refused (403) for driver and dispatcher; allowed for owner/management; COI allowed for driver', async () => {
  const db = fakeDb();
  for (const role of ['driver', 'dispatcher']) {
    for (const n of [2, 5]) assert.equal((await VAULT.GET(vreq('GET', { qs: `?view=${id(n)}` }), { deps: deps(role, db) })).status, 403, `${role} ${n}`);
    assert.equal((await VAULT.GET(vreq('GET', { qs: `?view=${id(3)}` }), { deps: deps(role, db) })).status, 200);
  }
  for (const role of ['owner', 'management']) {
    const j = await (await VAULT.GET(vreq('GET', { qs: `?view=${id(2)}` }), { deps: deps(role, db) })).json();
    assert.match(j.url, /^https:\/\/fake\.storage\/owner1\/company\/vault-w9/);
  }
  assert.equal((await VAULT.GET(vreq('GET', { qs: `?view=${id(9)}` }), { deps: deps('owner', db) })).status, 404); // not a vault doc
  assert.equal((await VAULT.GET(vreq('GET', { qs: '?view=nope' }), { deps: deps('owner', db) })).status, 404);
});

test('POST upload: driver/dispatcher 403; size and type checked; finish saves under the owner and verifies the file', async () => {
  const db = fakeDb();
  const start = (role, b) => VAULT.POST(vreq('POST', { body: { action: 'start', docType: 'noa', filename: 'VAULT-04_NOA_DemoCarrier_FAKE.pdf', size: 50_000, contentType: 'application/pdf', ...b } }), { deps: deps(role, db) });
  assert.equal((await start('driver')).status, 403);
  assert.equal((await start('dispatcher')).status, 403);
  assert.equal((await start('management', { size: 8_000_000 })).status, 422);
  assert.equal((await start('management', { docType: 'bol' })).status, 422);
  const s = await (await start('management')).json();
  assert.equal(s.path, 'owner1/company/vault-noa-1-VAULT-04_NOA_DemoCarrier_FAKE.pdf'); assert.equal(s.token, 'fake-upload-token');
  const finish = (b) => VAULT.POST(vreq('POST', { body: { action: 'finish', docType: 'noa', path: s.path, filename: 'VAULT-04_NOA_DemoCarrier_FAKE.pdf', ...b } }), { deps: deps('management', db) });
  assert.equal((await finish()).status, 409); // nothing uploaded yet
  assert.equal((await finish({ path: 'someoneelse/company/vault-noa-1-x.pdf' })).status, 400);
  db.files[s.path] = Buffer.from('%PDF-1.4 fake noa');
  const j = await (await finish()).json();
  const row = db.tbl.documents.find((d) => d.file_path === s.path);
  assert.equal(row.user_id, OWNER); assert.equal(row.doc_type, 'noa'); assert.equal(row.load_id, null);
  assert.equal(j.vault.find((r) => r.type === 'noa').current.id, row.id); // newest wins
  db.files['owner1/company/vault-noa-1-big.pdf'] = Buffer.alloc(MAX_VAULT_FILE_BYTES + 1);
  assert.equal((await finish({ path: 'owner1/company/vault-noa-1-big.pdf' })).status, 422);
  assert.equal(db.files['owner1/company/vault-noa-1-big.pdf'], undefined); // oversize file removed
});

test('DELETE: driver 403; management deletes the current W-9 and the previous one is current again', async () => {
  const db = fakeDb();
  assert.equal((await VAULT.DELETE(vreq('DELETE', { qs: `?id=${id(2)}` }), { deps: deps('driver', db) })).status, 403);
  const j = await (await VAULT.DELETE(vreq('DELETE', { qs: `?id=${id(2)}` }), { deps: deps('management', db) })).json();
  assert.equal(j.deleted, id(2));
  assert.equal(j.vault.find((r) => r.type === 'w9').current.id, id(1));
  assert.ok(db.log.some((l) => l[0] === 'remove' && l[1][0].includes('vault-w9-2')));
  assert.equal((await VAULT.DELETE(vreq('DELETE', { qs: `?id=${id(9)}` }), { deps: deps('owner', db) })).status, 404); // rate con: not the vault's to delete
});

// ---------- Send to broker with vault attachments ----------
const PID = '00000000-0000-4000-8000-0000000000f6';
const ENV = { POSTMARK_SERVER_TOKEN: 'fake-token-for-tests' };
const pkt = () => ({ id: PID, owner_id: OWNER, status: 'review', original_filename: 'Broker Packet (FAKE).pdf', filled_path: 'owner1/packets/filled/x.pdf' });
const sreq = (body, method = 'POST') => new Request(`http://x/api/packets/${PID}/send`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const suc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async () => ({ data: role }) });
const mockFetch = () => { const calls = []; const f = async (u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-123' }), { status: 200 }); }; f.calls = calls; return f; };
const BODY = (o = {}) => ({ to: 'dispatch@fstrucks.com', cc: '', subject: 'Packet (FAKE)', body: 'Hi (FAKE)', confirm: true, idempotencyKey: '11111111-1111-4111-8111-111111111111', ...o });

test('send GET: owner/management get vault options (COI ticked when OK); dispatcher gets none', async () => {
  const db = fakeDb({ packet: pkt() });
  const j = await (await SEND.GET(sreq(null, 'GET'), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('management'), env: ENV } })).json();
  assert.deepEqual(j.vault.options.map((o) => [o.type, o.available]), [['w9', true], ['coi', true], ['mc_authority', true], ['noa', true]]);
  assert.ok(j.vault.options.every((o) => typeof o.size === 'number'));
  assert.equal(j.vault.maxRaw, 7_500_000); assert.equal(typeof j.vault.packetSize, 'number');
  const d = await (await SEND.GET(sreq(null, 'GET'), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('dispatcher'), env: ENV } })).json();
  assert.equal(d.vault, null);
});

test('send POST (6A + 5B): each vault file is its own PDF attachment; ids recorded in packet_sends', async () => {
  const db = fakeDb({ packet: pkt() });
  const f = mockFetch();
  const res = await SEND.POST(sreq(BODY({ attachDocumentIds: [id(2), id(3)] })), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('owner'), env: ENV, fetch: f } });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j)); assert.equal(j.attachedCount, 2);
  assert.deepEqual(f.calls[0].Attachments.map((a) => a.Name), ['Broker_Packet_FAKE_-filled.pdf', 'W-9.pdf', 'COI.pdf']);
  assert.ok(f.calls[0].Attachments.every((a) => a.ContentType === 'application/pdf'));
  assert.deepEqual(db.tbl.packet_sends[0].attached_document_ids, [id(2), id(3)]);
  assert.deepEqual(j.sends[0].attached, [id(2), id(3)]);
});

test('send POST: works before the 5B column exists (claim retried without it)', async () => {
  const db = fakeDb({ packet: pkt(), sendsHasColumn: false });
  const f = mockFetch();
  const res = await SEND.POST(sreq(BODY({ attachDocumentIds: [id(3)] })), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('owner'), env: ENV, fetch: f } });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].Attachments.length, 2);
  assert.equal(db.tbl.packet_sends.length, 1); assert.ok(!('attached_document_ids' in db.tbl.packet_sends[0]));
});

test('send POST: #64 fstrucks.com-only limit unchanged with attachments; too large / stale ids refuse WITHOUT calling Postmark', async () => {
  const f = mockFetch();
  const run = async (body, db = fakeDb({ packet: pkt() }), env = ENV) => (await SEND.POST(sreq(body), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('owner'), env, fetch: f } }));
  assert.equal((await run(BODY({ to: 'broker@outside.example', attachDocumentIds: [id(2)] }))).status, 403);
  assert.equal((await run(BODY({ cc: 'x@outside.example', attachDocumentIds: [id(3)] }))).status, 403);
  assert.equal((await run(BODY({ attachDocumentIds: [id(1)] }))).status, 409); // earlier W-9, not current
  assert.equal((await run(BODY({ attachDocumentIds: [id(9)] }))).status, 409); // not a vault doc
  assert.equal((await run(BODY({ attachDocumentIds: ['nope'] }))).status, 400);
  const bigDb = fakeDb({ packet: pkt() });
  bigDb.files[doc(3, 'coi').file_path] = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(7_600_000)]);
  const big = await run(BODY({ attachDocumentIds: [id(3)] }), bigDb);
  assert.equal(big.status, 413); assert.match((await big.json()).error, /Nothing was sent/);
  assert.equal(bigDb.tbl.packet_sends.length, 0);
  assert.equal(f.calls.length, 0);
  // no attachments → exactly the old behaviour (one attachment)
  const plain = await run(BODY());
  assert.equal(plain.status, 200); assert.equal(f.calls.at(-1).Attachments.length, 1);
});

test('wiring: Company page renders the vault before Insurance; Insurance Upload COI jumps to it; send UI passes attachDocumentIds', () => {
  const cp = read('app/company/page.js');
  assert.ok(cp.indexOf('<CompanyDocuments />') > 0 && cp.indexOf('<CompanyDocuments />') < cp.indexOf('<CompanyInsurance />'));
  const ui = read('app/company/CompanyDocuments.js');
  assert.match(ui, /uploadToSignedUrl\(start\.path, start\.token, file/);
  assert.match(ui, /<ConfirmButton label="Delete" prompt=\{deleteCurrentPrompt/);
  assert.match(ui, /data-testid="vault-restricted"/);
  assert.doesNotMatch(ui, /\.from\('documents'\)\.(select|insert|update|delete)/); // no direct table reads: everything goes through the role-checked API
  const sb = read('app/packets/PacketSendBroker.js');
  assert.match(sb, /attachDocumentIds: ticked\.map\(\(o\) => o\.id\)/);
  assert.match(sb, /data-testid="send-attachments"/);
});

test('migration 5B: additive, nullable, idempotent, not referenced as applied', () => {
  const m = read('supabase/migrations/20261018000500_packet_sends_attached_documents.sql');
  assert.match(m, /NOT APPLIED/);
  assert.match(m, /alter table public\.packet_sends add column if not exists attached_document_ids uuid\[\] null;/);
  assert.doesNotMatch(m.replace(/^--.*$/gm, ''), /\b(drop|delete|update|truncate|grant|policy)\b/i);
});
