// PR #84 Company Documents vault (Marc's picks 1A, 2C, 3A, 4A, 5B, 6A + Taylor's notes). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { groupVault, vaultForRole, vaultStatus, coiExpiry, canOpenVaultFile, canManageVault, checkVaultUpload, checkSendSize, encodedSize,
  companyAttentionCount, companyAttentionLabel, sendAttachmentOptions, deleteCurrentPrompt, vaultPath, isVaultPathFor, MAX_VAULT_FILE_BYTES, VAULT_TYPE_IDS, VAULT_RESTRICTED_TYPES, canSeeEarlierVersions } from '../../app/lib/companyDocs.js';
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

test('2C (Marc Oct 18): owner/management open all four; dispatcher/driver open the COI only; nobody else opens anything', () => {
  for (const r of ['owner', 'management']) { assert.equal(canManageVault(r), true); assert.equal(canSeeEarlierVersions(r), true); for (const t of VAULT_TYPE_IDS) assert.equal(canOpenVaultFile(r, t), true, `${r} ${t}`); }
  for (const r of ['dispatcher', 'driver']) {
    assert.equal(canManageVault(r), false); assert.equal(canSeeEarlierVersions(r), false);
    assert.equal(canOpenVaultFile(r, 'coi'), true, r);
    for (const t of ['w9', 'mc_authority', 'noa']) assert.equal(canOpenVaultFile(r, t), false, `${r} ${t}`);
  }
  for (const r of ['nobody', undefined, null]) for (const t of VAULT_TYPE_IDS) assert.equal(canOpenVaultFile(r, t), false, `${r} ${t}`);
  assert.deepEqual([...VAULT_RESTRICTED_TYPES].sort(), ['mc_authority', 'noa', 'w9']);
  assert.equal(canOpenVaultFile('owner', 'rate_confirmation'), false);
});

const DOCS_2COI = () => [...DOCS(), doc(6, 'coi', '2026-09-01T10:00:00Z')]; // id(3) current, id(6) earlier

test('2C: vaultForRole gives dispatcher/driver the current COI (no earlier versions); W-9, MC, NOA status only', () => {
  const g = groupVault(DOCS_2COI());
  for (const role of ['driver', 'dispatcher']) {
    const v = vaultForRole(g, role, { policies: POLICIES, today: TODAY });
    for (const type of ['w9', 'mc_authority', 'noa']) {
      const r = v.find((x) => x.type === type);
      assert.equal(r.restricted, true, type); assert.equal(r.onFile, true);
      assert.deepEqual(Object.keys(r).sort(), ['label', 'onFile', 'restricted', 'status', 'type']);
      assert.deepEqual(Object.keys(r.status).sort(), ['level', 'text']);
    }
    const coi = v.find((x) => x.type === 'coi');
    assert.equal(coi.restricted, false); assert.equal(coi.current.id, id(3)); assert.deepEqual(coi.earlier, []);
    assert.equal(coi.status.hint, null); assert.ok(coi.status.expiryText);
    assert.doesNotMatch(JSON.stringify(v), /W9_DemoCarrier|MC_AUTHORITY_DemoCarrier|NOA_DemoCarrier|vault-(w9|mc_authority|noa)|_6\.pdf/);
    assert.doesNotMatch(JSON.stringify(v), new RegExp(id(6)));
  }
  const own = vaultForRole(g, 'management', { policies: POLICIES, today: TODAY });
  assert.ok(own.every((r) => r.restricted === false));
  assert.equal(own.find((x) => x.type === 'w9').current.id, id(2));
  assert.equal(own.find((x) => x.type === 'w9').earlier.length, 1);
  assert.deepEqual(own.find((x) => x.type === 'coi').earlier.map((d) => d.id), [id(6)]);
  assert.equal(own.find((x) => x.type === 'mc_authority').current.id, id(4));
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

test('a flagged COI stays on file and counts as needing attention', () => {
  const low = [
    { owner_id: OWNER, coverage: 'auto_liability', limit_amount: 1000000, expiry_date: '2027-03-01', confirmed: true },
    { owner_id: OWNER, coverage: 'cargo', limit_amount: 50000, expiry_date: '2027-02-01', confirmed: true },
  ];
  const rows = vaultForRole(groupVault(DOCS()), 'driver', { policies: low, today: TODAY });
  const coi = rows.find((r) => r.type === 'coi');
  assert.equal(coi.onFile, true);
  assert.equal(coi.status.level, 'bad');
  assert.equal(coi.status.text, 'Check notes');
  assert.equal(rows.filter((r) => r.onFile).length, 4);
  assert.equal(companyAttentionCount(rows), 1);
  assert.equal(companyAttentionLabel(1), '1 needs attention');
  assert.equal(companyAttentionLabel(2), '2 need attention');
  assert.equal(companyAttentionCount(vaultForRole(groupVault(DOCS()), 'owner', { policies: POLICIES, today: TODAY })), 0);
  assert.match(read('app/company/CompanyDocuments.js'), /data-testid="company-attention"/);
  assert.match(read('app/components/VaultTiles.js'), /companyAttentionCount\(vault\.vault\)/);
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
  assert.match(page, /commitDocs\(\(got\.documents \|\| \[\]\)\.filter\(isDocumentsTabDoc\)/);
  assert.match(page, /data-testid="vault-note"/);
});

test('load delete never deletes company docs, only unlinks them', async () => {
  const calls = [];
  const sb = { from: (t) => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }),
    update: (p) => ({ eq: async (c, v) => { calls.push(['update', t, v]); return { error: null }; } }),
    delete: () => ({ eq: (c, v) => { const pr = { select: async () => { calls.push(['delete', t, v]); return { data: [{ id: v }], error: null }; } }; pr.then = (a, b) => { calls.push(['delete', t, v]); return Promise.resolve({ error: null }).then(a, b); }; return pr; } }),
  }), storage: { from: () => ({ remove: async (p) => { calls.push(['storage', p[0]]); return { error: null }; } }) }, rpc: async () => ({ data: 0, error: null }) };
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

test('GET /api/company/documents: driver/dispatcher get the current COI details only (server-side 2C)', async () => {
  const db = fakeDb({ docs: DOCS_2COI() });
  for (const role of ['driver', 'dispatcher']) {
    const res = await VAULT.GET(vreq('GET'), { deps: deps(role, db) });
    assert.equal(res.status, 200);
    const txt = await res.text(); const j = JSON.parse(txt);
    assert.equal(j.canManage, false);
    assert.doesNotMatch(txt, /W9_DemoCarrier|MC_AUTHORITY_DemoCarrier|NOA_DemoCarrier|vault-(w9|mc_authority|noa)/);
    assert.doesNotMatch(txt, new RegExp(id(6))); // earlier COI never leaves the server
    const coi = j.vault.find((r) => r.type === 'coi');
    assert.equal(coi.restricted, false); assert.equal(coi.current.id, id(3)); assert.match(coi.current.original_filename, /COI_DemoCarrier/); assert.deepEqual(coi.earlier, []);
    for (const t of ['w9', 'mc_authority', 'noa']) { const r = j.vault.find((x) => x.type === t); assert.equal(r.restricted, true); assert.ok(!r.current && !r.earlier); }
    assert.equal(j.vault.find((r) => r.type === 'w9').status.text, 'On file');
  }
  const m = await (await VAULT.GET(vreq('GET'), { deps: deps('management', db) })).json();
  assert.equal(m.canManage, true); assert.equal(m.vault.find((r) => r.type === 'w9').current.id, id(2));
  assert.deepEqual(m.vault.find((r) => r.type === 'coi').earlier.map((d) => d.id), [id(6)]); assert.equal(m.vault.find((r) => r.type === 'mc_authority').current.id, id(4));
});

test('GET ?view=: driver/dispatcher may open the current COI only; W-9, MC, NOA and earlier COIs refused (403); owner/management open all', async () => {
  const db = fakeDb({ docs: DOCS_2COI() });
  for (const role of ['driver', 'dispatcher']) {
    const ok = await (await VAULT.GET(vreq('GET', { qs: `?view=${id(3)}` }), { deps: deps(role, db) })).json();
    assert.match(ok.url, /^https:\/\/fake\.storage\/owner1\/company\/vault-coi-3/, role);
    for (const n of [1, 2, 4, 5, 6]) {
      const r = await VAULT.GET(vreq('GET', { qs: `?view=${id(n)}` }), { deps: deps(role, db) });
      assert.equal(r.status, 403, `${role} ${n}`);
      const j = await r.json(); assert.ok(!j.url); assert.match(j.error, /owner or management/);
    }
  }
  for (const role of ['owner', 'management']) {
    for (const [n, t] of [[2, 'w9'], [3, 'coi'], [4, 'mc_authority'], [5, 'noa'], [6, 'coi'], [1, 'w9']]) {
      const j = await (await VAULT.GET(vreq('GET', { qs: `?view=${id(n)}` }), { deps: deps(role, db) })).json();
      assert.match(j.url, new RegExp(`^https://fake\\.storage/owner1/company/vault-${t}-${n}`), `${role} ${t} ${n}`);
    }
  }
  assert.equal((await VAULT.GET(vreq('GET', { qs: `?view=${id(9)}` }), { deps: deps('driver', db) })).status, 404); // not a vault doc
  assert.equal((await VAULT.GET(vreq('GET', { qs: '?view=nope' }), { deps: deps('owner', db) })).status, 404);
});

test('driver/dispatcher still cannot upload, replace or delete anything (including the COI)', async () => {
  const db = fakeDb({ docs: DOCS_2COI() });
  for (const role of ['driver', 'dispatcher']) {
    const start = await VAULT.POST(vreq('POST', { body: { action: 'start', docType: 'coi', filename: 'COI_FAKE.pdf', size: 50_000, contentType: 'application/pdf' } }), { deps: deps(role, db) });
    assert.equal(start.status, 403, role);
    for (const n of [3, 6, 2]) assert.equal((await VAULT.DELETE(vreq('DELETE', { qs: `?id=${id(n)}` }), { deps: deps(role, db) })).status, 403, `${role} delete ${n}`);
  }
  assert.equal(db.tbl.documents.length, DOCS_2COI().length);
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

// ---------- #89 QA round 1 ----------
test('QA c: unconfirmed suggestions (even expired) never block On file; ≤30 days is amber; order red > 30-day amber > notes > green', () => {
  const coi = groupVault(DOCS()).find((x) => x.type === 'coi');
  const expiredSuggestion = { owner_id: OWNER, coverage: 'cargo', limit_amount: 100000, expiry_date: '2026-01-01', confirmed: false };
  const ok = vaultStatus(coi, { policies: [...POLICIES, expiredSuggestion], today: TODAY });
  assert.equal(ok.level, 'ok'); assert.equal(ok.text, 'On file');
  assert.match(ok.hint, /1 suggested policy .* still needs your review/);
  const soon = vaultStatus(coi, { policies: [...POLICIES, expiredSuggestion], today: '2027-01-15' });
  assert.equal(soon.level, 'warn'); assert.equal(soon.text, 'Expires within 30 days');
  const soonWithNotes = vaultStatus(coi, { policies: [POLICIES[0], { ...POLICIES[1], limit_amount: null }], today: '2027-01-15' });
  assert.equal(soonWithNotes.text, 'Expires within 30 days'); // not hidden behind "Check notes"
  assert.equal(vaultStatus(coi, { policies: [POLICIES[0], { ...POLICIES[1], limit_amount: null }], today: TODAY }).text, 'Check notes');
  assert.equal(vaultStatus(coi, { policies: [POLICIES[0], { ...POLICIES[1], expiry_date: '2026-10-01' }], today: TODAY }).level, 'bad'); // confirmed + expired
  assert.equal(vaultStatus(coi, { policies: [POLICIES[0], expiredSuggestion], today: TODAY }).level, 'bad'); // cargo only suggested = missing
});

test('QA a: Insurance shows ONE Suggest button for the current COI; earlier versions collapsed with dates', () => {
  const ui = read('app/company/CompanyInsurance.js');
  assert.match(ui, /suggestBtn\(docs\[0\], `Suggest policies from \$\{docs\[0\]\.original_filename \|\| 'COI'\} \(current\)`\)/);
  assert.match(ui, /showEarlier && docs\.slice\(1\)\.map/);
  assert.match(ui, /data-testid="suggest-earlier-toggle"/);
  assert.doesNotMatch(ui, /: docs\.map\(\(d\) => <button/);
  // pre-vault #66 behaviour kept: Suggest saves rows as unconfirmed suggestions that need Confirm
  const route = read('app/api/company/insurance/suggest/route.js');
  assert.match(route, /saved with confirmed = false/);
});

test('QA b: Insurance changes refresh the vault COI row (and vault changes refresh the Insurance COI list)', () => {
  const ins = read('app/company/CompanyInsurance.js');
  assert.match(ins, /if \(ok\) setMsg\(ok\); notifyVault\(\); return r;/);
  assert.match(ins, /window\.addEventListener\(VAULT_CHANGED_EVENT/);
  const v = read('app/company/CompanyDocuments.js');
  assert.match(v, /window\.addEventListener\(INSURANCE_CHANGED_EVENT, h\)/);
  assert.match(v, /clearErrors\(\); changed\(\);/);
});

test('QA d: the file-type error clears on the next pick or the next successful action', () => {
  const v = read('app/company/CompanyDocuments.js');
  const up = v.slice(v.indexOf('async function upload'), v.indexOf('async function view'));
  assert.match(up, /setMsg\(null\); clearErrors\(\);\s*const contentType/); // a new pick clears first
  assert.match(v, /onScan=\{\(files\) => \{ clearErrors\(\);/);
  assert.match(v.slice(v.indexOf('async function view'), v.indexOf('async function remove')), /clearErrors\(\);/);
});

test('QA e: row buttons stack full width below 640px', () => {
  const css = read('app/globals.css');
  assert.match(css, /@media \(max-width: 639\.98px\) \{\s*\.vault-actions \{ flex-direction: column; align-items: stretch; \}/);
  assert.match(css, /\.vault-actions > \* \{ width: 100%;/);
  assert.match(read('app/company/CompanyDocuments.js'), /className="vault-actions"/);
});

test('QA f: Send to broker GET still answers when the vault part fails; the panel shows an error instead of vanishing', async () => {
  const db = fakeDb({ packet: pkt() });
  db.storage.from = () => ({ list: async () => { throw new Error('storage down (FAKE)'); }, download: async () => { throw new Error('x'); } });
  const real = db.from;
  db.from = (t) => { if (t === 'insurance_policies') throw new Error('boom (FAKE)'); return real(t); };
  const res = await SEND.GET(sreq(null, 'GET'), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('owner'), env: ENV } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.canSend, true); assert.ok(Array.isArray(j.vault.options));
  const ui = read('app/packets/PacketSendBroker.js');
  assert.match(ui, /data-testid="send-load-error"/);
});

// ---- #89 re-QA (Taylor) ----
import { coiCoverage, fmtSize, fmtMB, sentence } from '../../app/lib/companyDocs.js';
const pol = (coverage, limit_amount, expiry_date, o = {}) => ({ owner_id: OWNER, coverage, limit_amount, expiry_date, effective_date: '2026-01-01', confirmed: true, ...o });
const AUTO = pol('auto_liability', 1000000, '2027-03-01');

test('re-QA 2: each coverage is judged by its best valid confirmed policy (older $50k cargo next to a new $100k)', () => {
  const policies = [AUTO, pol('cargo', 50000, '2027-02-01'), pol('cargo', 100000, '2027-05-01')];
  const st = vaultStatus({ type: 'coi', current: doc(3, 'coi', '2026-10-02T10:00:00Z') }, { policies, today: TODAY });
  assert.equal(st.level, 'ok'); assert.equal(st.text, 'On file'); assert.equal(st.note, null);
  assert.equal(coiCoverage(policies, null, TODAY).best.cargo.limit_amount, 100000);
  // only the $50k one → still below the minimum, without a double period
  const low = vaultStatus({ type: 'coi', current: doc(3, 'coi', '2026-10-02T10:00:00Z') }, { policies: [AUTO, pol('cargo', 50000, '2027-02-01')], today: TODAY });
  assert.equal(low.level, 'bad'); assert.match(low.note, /Cargo limit \$50,000 is below the \$100,000 minimum\.$/);
});

test('re-QA 2: expired, not-yet-effective and unconfirmed policies never count as the best', () => {
  const C = { type: 'coi', current: doc(3, 'coi', '2026-10-02T10:00:00Z') };
  // an expired $1M cargo does not hide that the valid one is only $50k
  assert.equal(vaultStatus(C, { policies: [AUTO, pol('cargo', 1000000, '2026-09-01'), pol('cargo', 50000, '2027-02-01')], today: TODAY }).level, 'bad');
  // an expired old policy next to a good valid one doesn't flag the COI
  assert.equal(vaultStatus(C, { policies: [AUTO, pol('cargo', 50000, '2026-09-01'), pol('cargo', 100000, '2027-05-01')], today: TODAY }).level, 'ok');
  // future-dated only → red
  const fut = vaultStatus(C, { policies: [AUTO, pol('cargo', 100000, '2027-12-01', { effective_date: '2026-12-01' })], today: TODAY });
  assert.equal(fut.level, 'bad'); assert.match(fut.note, /isn’t effective until 2026-12-01/);
  // only expired → "Expired"
  assert.equal(vaultStatus(C, { policies: [AUTO, pol('cargo', 100000, '2026-10-01')], today: TODAY }).text, 'Expired');
  // unconfirmed $100k doesn't rescue a confirmed $50k
  assert.equal(vaultStatus(C, { policies: [AUTO, pol('cargo', 50000, '2027-02-01'), pol('cargo', 100000, '2027-05-01', { confirmed: false })], today: TODAY }).level, 'bad');
  // tie on limit → the later expiry is used
  assert.equal(coiCoverage([AUTO, pol('cargo', 100000, '2026-11-01'), pol('cargo', 100000, '2027-05-01')], null, TODAY).best.cargo.expiry_date, '2027-05-01');
});

test('re-QA 3: the best policy expiring within 30 days turns the COI amber', () => {
  const C = { type: 'coi', current: doc(3, 'coi', '2026-10-02T10:00:00Z') };
  const policies = [AUTO, pol('cargo', 50000, '2027-02-01'), pol('cargo', 100000, '2026-11-05')];
  const st = vaultStatus(C, { policies, today: TODAY });
  assert.equal(st.level, 'warn'); assert.equal(st.text, 'Expires within 30 days'); assert.equal(st.expiry, '2026-11-05');
  assert.equal(coiExpiry(policies, TODAY), '2026-11-05');
  // day 31 is green
  assert.equal(vaultStatus(C, { policies: [AUTO, pol('cargo', 100000, '2026-11-18')], today: TODAY }).level, 'ok');
  assert.equal(vaultStatus(C, { policies: [AUTO, pol('cargo', 100000, '2026-11-17')], today: TODAY }).level, 'warn');
});

test('re-QA 2: adding a policy refreshes the vault COI row right away (event after every successful Insurance change)', () => {
  const ins = read('app/company/CompanyInsurance.js'), vault = read('app/company/CompanyDocuments.js');
  assert.match(ins, /runInner[\s\S]*?notifyVault\(\)/);
  assert.match(ins, /Add policy/); assert.match(ins, /\/api\/company\/insurance\/policies', \{ method: 'POST'[\s\S]*?\.then/);
  assert.match(vault, /addEventListener\(INSURANCE_CHANGED_EVENT/);
});

test('re-QA 1: every COI that is not current is grouped under "Earlier COIs (n)", whatever page uploaded it', () => {
  const ins = read('app/company/CompanyInsurance.js');
  // the list is every coi row (no file_path / vault-only filter), so Insurance-page uploads are grouped too
  assert.match(ins, /from\('documents'\)\.select\('id,original_filename,created_at'\)\.eq\('doc_type', 'coi'\)\.order\('created_at', \{ ascending: false \}\)/);
  assert.doesNotMatch(ins, /docs\.map\(/);
  assert.match(ins, /Earlier COIs \(\{docs\.length - 1\}\)/);
  assert.match(ins, /showEarlier && docs\.slice\(1\)\.map/);
  // the vault agrees on "current": newest coi row, Insurance-page uploads included
  const g = groupVault([doc(3, 'coi', '2026-10-02T10:00:00Z', { file_path: `${OWNER}/insurance/fake-coi.jpg`, original_filename: 'fake-coi.jpg' }),
    doc(6, 'coi', '2026-10-03T10:00:00Z', { file_path: `${OWNER}/insurance/fake-coi.jpg`, original_filename: 'fake-coi.jpg' }),
    doc(7, 'coi', '2026-10-18T10:00:00Z', { original_filename: 'COI_DemoCarrier_VAULT-02_FAKE.pdf' })]).find((x) => x.type === 'coi');
  assert.equal(g.current.id, id(7)); assert.equal(g.earlier.length, 2);
  // preview build tag so a stale open tab is obvious
  assert.match(read('app/company/CompanyDocuments.js'), /NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA/);
});

test('re-QA minor: sizes under 0.1 MB show in KB (attachments and total); one period before "It\'s unticked"', () => {
  assert.equal(fmtSize(48_000), '48 KB'); assert.equal(fmtSize(99_499), '99 KB'); assert.equal(fmtSize(100_000), '0.1 MB');
  assert.equal(fmtSize(2_400_000), '2.4 MB'); assert.equal(fmtSize(300), '1 KB'); assert.equal(fmtSize(0), '0 KB'); assert.equal(fmtMB, fmtSize);
  const ui = read('app/packets/PacketSendBroker.js');
  assert.match(ui, /fmtMB\(o\.size\)/); assert.match(ui, /Total \$\{fmtMB\(size\.raw\)\}/);
  assert.equal(sentence('Cargo limit $50,000 is below the $100,000 minimum.'), 'Cargo limit $50,000 is below the $100,000 minimum.');
  const opts = sendAttachmentOptions(groupVault([doc(3, 'coi', '2026-10-02T10:00:00Z')]), { policies: [AUTO, pol('cargo', 50000, '2027-02-01')], today: TODAY });
  const coi = opts.find((o) => o.type === 'coi');
  assert.ok(coi.warning); assert.doesNotMatch(coi.warning, /\.\./); assert.match(coi.warning, /minimum\. It's unticked/);
});

test('Send to broker: only owner/management can attach vault files (dispatcher/driver get no options and POST is refused, Postmark untouched)', async () => {
  const db = fakeDb({ packet: pkt() });
  for (const role of ['dispatcher', 'driver']) {
    const g = await (await SEND.GET(sreq(null, 'GET'), { params: { id: PID }, deps: { sb: db, mkUserClient: suc(role), env: ENV } })).json();
    assert.equal(g.vault, null, role); assert.equal(g.canSend, false);
    const f = mockFetch();
    const r = await SEND.POST(sreq(BODY({ attachDocumentIds: [id(2), id(3), id(4), id(5)] })), { params: { id: PID }, deps: { sb: db, mkUserClient: suc(role), env: ENV, fetch: f } });
    assert.equal(r.status, 403, role); assert.equal(f.calls.length, 0);
  }
  assert.equal((db.tbl.packet_sends || []).length, 0);
  const o = await (await SEND.GET(sreq(null, 'GET'), { params: { id: PID }, deps: { sb: db, mkUserClient: suc('owner'), env: ENV } })).json();
  assert.equal(o.vault.options.length, 4);
});

test('UI: restricted rows show only the pill and the note; members get View but no upload/delete', () => {
  const ui = read('app/company/CompanyDocuments.js');
  assert.match(ui, /r\.restricted \? \(\s*<p data-testid="vault-restricted"[^>]*>Only the owner and management can open the \{t\?\.short \|\| r\.label\}\.<\/p>\s*\) : \(/);
  assert.match(ui, /\{r\.current && <button[^\n]*?data-testid="vault-view">View<\/button>\}/);
  assert.match(ui, /\{st\.canManage && \(\s*<div className="vault-upload">/); assert.match(ui, /\{st\.canManage && r\.current && \(<div className="vault-delete">/);
  assert.match(read('app/lib/vaultServer.js'), /Only the owner or management can open earlier versions\./);
});
