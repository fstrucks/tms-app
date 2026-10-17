import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packetDisplayStatus, fieldSummary, addFieldHint, ADD_FIELD_HINT, ADD_FIELD_HINT_VIEW, filterPackets, filterCounts, PACKET_FILTERS, unarchivedStatus, canManagePackets, pollDelay, POLL_MAX_MS, PACKET_STATUS_LABELS } from '../../app/lib/packetStatus.js';
import { listPackets, LIST_COLS } from '../../app/lib/packetList.js';
import { packetStoragePaths } from '../../app/lib/packetDelete.js';
import { GET as LIST } from '../../app/api/packets/route.js';
import { DELETE } from '../../app/api/packets/[id]/route.js';
import { POST as ARCHIVE } from '../../app/api/packets/[id]/archive/route.js';

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const P1 = '00000000-0000-4000-8000-0000000000a1', P2 = '00000000-0000-4000-8000-0000000000a2', P3 = '00000000-0000-4000-8000-0000000000a3';

// --- display status -------------------------------------------------------------------------------
test('display status: one label per state, shared keys', () => {
  const S = (o, sum) => packetDisplayStatus({ status: 'review', ...o }, sum).key;
  const sum = (fieldCount, sigTotal = 0, sigSigned = 0) => ({ fieldCount, sigTotal, sigSigned });
  assert.equal(S({ status: 'received' }, sum(0)), 'received');
  assert.equal(S({ status: 'processing' }, sum(0)), 'processing');
  assert.equal(S({ status: 'error' }, sum(3)), 'error');
  assert.equal(S({ status: 'archived', sent_at: 'x' }, sum(3)), 'archived');
  assert.equal(S({ status: 'sent' }, sum(3, 1, 0)), 'sent');
  assert.equal(S({ sent_at: '2026-10-17T13:34:00Z' }, sum(3)), 'sent');
  assert.equal(S({}, sum(0)), 'needs_fields');
  assert.equal(S({}, sum(5, 2, 1)), 'needs_signature');
  assert.equal(S({ filled_at: 'x' }, sum(5, 2, 1)), 'needs_signature');
  assert.equal(S({ filled_at: 'x' }, sum(5, 1, 1)), 'filled');
  assert.equal(S({}, sum(5, 1, 1)), 'signed');
  assert.equal(S({}, sum(5)), 'ready');
  assert.equal(S({}, null), 'ready'); // summary unknown → pipeline label only
  // 'review' always reads "Ready to fill out" on both pages (the old list/detail mismatch).
  assert.equal(packetDisplayStatus({ status: 'review' }, sum(5)).label, 'Ready to fill out');
  assert.equal(packetDisplayStatus({ status: 'review' }, sum(5)).label, PACKET_STATUS_LABELS.review);
  assert.equal(packetDisplayStatus({ status: 'archived' }, null).label, 'Archived');
});

test('fieldSummary counts signature fields from DB rows or client fields', () => {
  assert.deepEqual(fieldSummary([{ kind: 'text' }, { kind: 'signature', signature_path: 'a' }, { profile_key: 'signature', kind: 'text' }]), { fieldCount: 3, sigTotal: 2, sigSigned: 1, unnamed: 2 });
  assert.deepEqual(fieldSummary([{ kind: 'signature', profile_key: 'signature', signed: true }]), { fieldCount: 1, sigTotal: 1, sigSigned: 1, unnamed: 0 });
  assert.deepEqual(fieldSummary([]), { fieldCount: 0, sigTotal: 0, sigSigned: 0, unnamed: 0 });
});

test('"Tap Add field" hint only on scanned/unreadable packets with no fields; view-only users get who can', () => {
  const none = { fieldCount: 0, sigTotal: 0, sigSigned: 0 };
  for (const r of ['no_text_layer', 'no_fields', 'reader_error', 'read_failed']) {
    assert.equal(addFieldHint({ status: 'review', manual_reason: r }, none, true), ADD_FIELD_HINT, r);
    assert.equal(addFieldHint({ status: 'review', manual_reason: r }, none, false), ADD_FIELD_HINT_VIEW, r);
  }
  assert.match(ADD_FIELD_HINT, /Tap “Add field”/);
  assert.doesNotMatch(ADD_FIELD_HINT_VIEW, /Tap|Add field/);
  assert.equal(addFieldHint({ status: 'review', manual_reason: 'no_text_layer' }, { ...none, fieldCount: 2 }, true), null);
  assert.equal(addFieldHint({ status: 'review', manual_reason: null }, none, true), null);
  assert.equal(addFieldHint({ status: 'archived', manual_reason: 'no_text_layer' }, none, true), null);
  assert.equal(addFieldHint({ status: 'review', manual_reason: 'no_text_layer' }, null, true), null);
});

test('filters: archived hidden from All; counts per chip', () => {
  const rows = ['ready', 'needs_fields', 'needs_signature', 'filled', 'signed', 'sent', 'archived', 'processing'].map((display, i) => ({ id: String(i), display }));
  assert.deepEqual(PACKET_FILTERS.map((f) => f.id), ['all', 'todo', 'filled', 'sent', 'archived']);
  assert.ok(!filterPackets(rows, 'all').some((r) => r.display === 'archived'));
  assert.equal(filterPackets(rows, 'all').length, 7);
  assert.deepEqual(filterCounts(rows), { all: 7, todo: 4, filled: 2, sent: 1, archived: 1 });
  assert.equal(filterPackets(rows, 'nope').length, 7);
});

test('unarchive restores the pipeline status; manage roles = owner + management', () => {
  assert.equal(unarchivedStatus({ sent_at: 'x', processed_at: 'x' }), 'sent');
  assert.equal(unarchivedStatus({ processed_at: 'x' }), 'review');
  assert.equal(unarchivedStatus({ processed_at: 'x', process_error: 'boom' }), 'error');
  assert.equal(unarchivedStatus({ processed_at: 'x', process_error: 'boom', manual_reason: 'reader_error' }), 'review');
  assert.equal(unarchivedStatus({}), 'received');
  assert.deepEqual(['owner', 'management', 'dispatcher', 'driver', null].map(canManagePackets), [true, true, false, false, false]);
});

test('polling backs off and is capped', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(pollDelay), [2000, 3000, 5000, 8000, 10000, 10000]);
  assert.ok(POLL_MAX_MS <= 3 * 60 * 1000);
});

// --- fakes ----------------------------------------------------------------------------------------
function fakeDb(tables, { failFrom = {}, jwtFail = false, failDelete = false } = {}) {
  const log = [];
  const from = (name) => {
    const st = { name, op: 'select', f: [], cols: '*', opts: {} };
    const rowsNow = () => (tables[name] || []).filter((r) => st.f.every((fn) => fn(r)));
    const run = () => {
      log.push({ name: st.name, op: st.op, cols: st.cols, filters: st.raw || [] });
      if (jwtFail) return { data: null, error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 };
      if (failFrom[name]) return { data: null, error: { code: 'XX000', message: 'fake failure' } };
      const rows = rowsNow();
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: st.sel ? rows.map((r) => ({ id: r.id })) : null, error: null }; }
      if (st.op === 'delete' && failDelete) return { error: { code: 'XX000', message: 'fake delete failure' } };
      if (st.op === 'delete') { tables[name] = (tables[name] || []).filter((r) => !rows.includes(r)); return { error: null }; }
      if (st.opts.head) return { data: null, count: rows.length, error: null };
      if (name === 'packets' && /packet_fields\(count\)/.test(st.cols)) return { data: rows.map((r) => ({ id: r.id, packet_fields: [{ count: (tables.packet_fields || []).filter((f) => f.packet_id === r.id).length }] })), error: null };
      return { data: st.one ? rows[0] || null : rows, error: null };
    };
    const b = {
      select(c = '*', o = {}) { if (st.op === 'select') { st.cols = c; st.opts = o; } else st.sel = true; return b; },
      eq(k, v) { (st.raw ||= []).push(`${k}=eq.${v}`); st.f.push((r) => r[k] === v); return b; },
      neq(k, v) { (st.raw ||= []).push(`${k}=neq.${v}`); st.f.push((r) => r[k] !== v); return b; },
      in(k, vs) { (st.raw ||= []).push(`${k}=in.${vs.length}`); st.f.push((r) => vs.includes(r[k])); return b; },
      or(expr) { (st.raw ||= []).push(`or=${expr}`); st.f.push((r) => r.kind === 'signature' || r.profile_key === 'signature' || (/profile_key\.is\.null/.test(expr) && r.profile_key == null)); return b; },
      order() { return b; }, limit() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; },
      maybeSingle: async () => { st.one = true; return run(); },
      then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    };
    return b;
  };
  return { from, log, tables };
}
const OWNER = 'owner1';
function world() {
  return {
    packets: [
      { id: P1, owner_id: OWNER, source: 'upload', status: 'review', subject: 'Scanned (FAKE)', created_at: '2026-10-17T15:00:00Z', manual_reason: 'no_text_layer', processed_at: 'x', file_path: `${OWNER}/packets/1-0-scan.pdf` },
      { id: P2, owner_id: OWNER, source: 'email', status: 'sent', subject: 'Broker A (FAKE)', created_at: '2026-10-17T14:00:00Z', sent_at: '2026-10-17T13:34:00Z', filled_at: 'x', processed_at: 'x', file_path: `${OWNER}/packets/2-0-a.pdf`, filled_path: `${OWNER}/packets/filled/${P2}-200.pdf` },
      { id: P3, owner_id: OWNER, source: 'upload', status: 'archived', subject: 'Old (FAKE)', created_at: '2026-10-10T14:00:00Z', processed_at: 'x', file_path: `${OWNER}/packets/3-0-old.pdf` },
      { id: '00000000-0000-4000-8000-0000000000ff', owner_id: 'stranger', source: 'upload', status: 'review', subject: 'Not mine', created_at: '2026-10-17T15:00:00Z', file_path: 'stranger/packets/x.pdf' },
    ],
    packet_fields: [
      { packet_id: P2, kind: 'text', profile_key: 'legal_name' },
      { packet_id: P2, kind: 'signature', profile_key: 'signature', signature_path: `${OWNER}/packets/signatures/${P2}/f1-100.png` },
      { packet_id: '00000000-0000-4000-8000-0000000000ff', kind: 'signature', profile_key: 'signature' },
    ],
    packet_sends: [{ packet_id: P2, filled_path: `${OWNER}/packets/filled/${P2}-150.pdf` }],
    company_profiles: [{ owner_id: OWNER }],
  };
}
// User client: RLS = only rows whose owner the caller belongs to.
function userDb(t, role, o = {}) {
  const visible = { ...t, packets: t.packets.filter((p) => p.owner_id === OWNER) };
  const db = fakeDb(visible, o);
  const rpcs = [];
  return { from: db.from, log: db.log, rpcs, auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async (fn, args) => { rpcs.push([fn, args]); return { data: args.p_owner === OWNER ? role : null }; } };
}

test('listPackets: RLS query first, then service summary ONLY for returned ids; statuses, hint, roles', async () => {
  const t = world();
  const uc = userDb(t, 'owner'); const sb = fakeDb(t);
  const timings = {};
  const r = await listPackets({ uc, sb, timings });
  assert.deepEqual(r.rows.map((x) => [x.id, x.display]), [[P1, 'needs_fields'], [P2, 'sent']]);
  assert.equal(r.rows[0].hint, ADD_FIELD_HINT);
  assert.equal(r.rows[0].canManage, true); assert.equal(r.canManage, true);
  assert.equal(r.archivedCount, 1); assert.equal(r.ownerId, OWNER);
  assert.deepEqual([r.rows[1].fieldCount, r.rows[1].sigTotal, r.rows[1].sigSigned], [2, 1, 1]);
  // Service queries are scoped to the 2 RLS-visible ids (never the stranger's packet).
  for (const q of sb.log) assert.ok(q.filters.some((f) => /=in\.2$/.test(f)), JSON.stringify(q));
  assert.equal(sb.log.length, 2);
  // Needed columns only; no file paths / signed URLs leave the server.
  assert.equal(uc.log[0].cols, LIST_COLS);
  assert.ok(!/file_path|filled_path|\*/.test(LIST_COLS));
  assert.ok(!JSON.stringify(r).includes('/packets/'));
  assert.ok(Number.isFinite(timings.db1) && Number.isFinite(timings.db2));
});

test('listPackets: drivers see status + view-only hint, no manage actions; archived view', async () => {
  const t = world();
  const d = await listPackets({ uc: userDb(t, 'driver'), sb: fakeDb(t) });
  assert.equal(d.rows[0].hint, ADD_FIELD_HINT_VIEW); assert.equal(d.rows[0].canManage, false); assert.equal(d.canManage, false);
  const disp = await listPackets({ uc: userDb(t, 'dispatcher'), sb: fakeDb(t) });
  assert.equal(disp.rows[0].hint, ADD_FIELD_HINT); assert.equal(disp.rows[0].canManage, false);
  const a = await listPackets({ uc: userDb(t, 'management'), sb: fakeDb(t), view: 'archived' });
  assert.deepEqual(a.rows.map((x) => [x.id, x.display, x.canManage]), [[P3, 'archived', true]]);
});

test('listPackets: expired token → 401; summary failure degrades to pipeline status', async () => {
  const t = world();
  assert.equal((await listPackets({ uc: userDb(t, 'owner', { jwtFail: true }), sb: fakeDb(t) })).status, 401);
  const r = await listPackets({ uc: userDb(t, 'owner'), sb: fakeDb(t, { failFrom: { packet_fields: true } }) });
  assert.deepEqual(r.rows.map((x) => x.display), ['ready', 'sent']);
  const empty = await listPackets({ uc: userDb({ ...t, packets: [] }, 'owner'), sb: fakeDb(t) });
  assert.deepEqual(empty.rows, []);
});

test('GET /api/packets: needs a token; returns Server-Timing', async () => {
  const t = world();
  const noTok = await LIST(new Request('http://x/api/packets'), { deps: { sb: fakeDb(t) } });
  assert.equal(noTok.status, 401);
  const res = await LIST(new Request('http://x/api/packets', { headers: { authorization: 'Bearer t' } }), { deps: { sb: fakeDb(t), mkUserClient: () => userDb(t, 'owner') } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('server-timing'), /db1;dur=\d+, db2;dur=\d+, total;dur=\d+/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).rows.length, 2);
});

// --- archive / delete routes ------------------------------------------------------------------------
const reqFor = (id, method, body) => new Request(`http://x/api/packets/${id}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const deps = (t, role, sb) => ({ sb, mkUserClient: () => userDb(t, role) });

test('archive: owner/management only; refuses while pending; unarchive restores status', async () => {
  const t = world(); const sb = fakeDb(t);
  const run = async (id, role, body) => { const r = await ARCHIVE(reqFor(id, 'POST', body), { params: { id }, deps: deps(t, role, sb) }); return [r.status, await r.json()]; };
  assert.equal((await run(P2, 'dispatcher', { archived: true }))[0], 403);
  assert.equal((await run(P2, 'driver', { archived: true }))[0], 403);
  assert.deepEqual(await run(P2, 'owner', { archived: true }), [200, { ok: true, status: 'archived' }]);
  assert.equal(t.packets[1].status, 'archived');
  assert.deepEqual(await run(P2, 'management', { archived: false }), [200, { ok: true, status: 'sent' }]);
  assert.deepEqual(await run(P3, 'owner', { archived: false }), [200, { ok: true, status: 'review' }]);
  t.packets[0].status = 'processing';
  assert.equal((await run(P1, 'owner', { archived: true }))[0], 409);
  assert.equal(t.packets[0].status, 'processing');
});

test('delete: owner/management only; removes row and ALL its storage files with the service key', async () => {
  const t = world();
  const removed = [];
  const listing = { [`${OWNER}/packets/filled`]: [{ id: 'a', name: `${P2}-150.pdf` }, { id: 'b', name: `${P2}-200.pdf` }, { id: 'c', name: `${P1}-9.pdf` }], [`${OWNER}/packets/signatures/${P2}`]: [{ id: 'd', name: 'f1-100.png' }, { id: 'e', name: 'f1-050.png' }] };
  const mk = (o = {}) => { const sb = fakeDb(t, o); sb.storage = { from: (bucket) => ({ list: async (dir, opt) => ({ data: (listing[dir] || []).filter((x) => !opt?.search || x.name.startsWith(opt.search)) }), remove: async (paths) => { if (o.storageFail) return { error: { message: 'fake storage down' } }; removed.push([bucket, ...paths]); return { error: null }; } }) }; return sb; };
  const del = async (id, role, sb) => { const r = await DELETE(reqFor(id, 'DELETE'), { params: { id }, deps: deps(t, role, sb) }); return [r.status, await r.json()]; };
  assert.equal((await del(P2, 'dispatcher', mk()))[0], 403);
  assert.equal((await del(P2, 'driver', mk()))[0], 403);
  assert.equal(t.packets.length, 4); assert.equal(removed.length, 0);
  const [code, body] = await del(P2, 'owner', mk());
  assert.equal(code, 200); assert.equal(body.ok, true);
  assert.ok(!t.packets.some((p) => p.id === P2));
  assert.equal(removed[0][0], 'documents');
  assert.deepEqual(removed[0].slice(1).sort(), [
    `${OWNER}/packets/2-0-a.pdf`, `${OWNER}/packets/filled/${P2}-150.pdf`, `${OWNER}/packets/filled/${P2}-200.pdf`,
    `${OWNER}/packets/signatures/${P2}/f1-050.png`, `${OWNER}/packets/signatures/${P2}/f1-100.png`,
  ].sort());
  assert.ok(!removed[0].some((p) => p.includes(P1)), 'never touches another packet\'s files');
  // Storage failure after the row is gone → reported, not hidden.
  const [c2, b2] = await del(P1, 'management', mk({ storageFail: true }));
  assert.equal(c2, 200); assert.match(b2.storageWarning, /could not be removed/);
  // Row delete failure → 500 and no storage removal.
  removed.length = 0;
  const [c3] = await del(P3, 'owner', mk({ failDelete: true }));
  assert.equal(c3, 500); assert.equal(removed.length, 0);
  assert.ok(t.packets.some((p) => p.id === P3));
});

test('packetStoragePaths ignores paths outside packets folders', async () => {
  const sb = fakeDb({ packet_fields: [{ packet_id: P1, signature_path: '../etc/passwd' }, { packet_id: P1, signature_path: null }], packet_sends: [] });
  sb.storage = { from: () => ({ list: async () => ({ data: [] }) }) };
  assert.deepEqual(await packetStoragePaths(sb, { id: P1, owner_id: OWNER, file_path: `${OWNER}/packets/1.pdf`, filled_path: 'elsewhere/x.pdf' }), [`${OWNER}/packets/1.pdf`]);
});

// --- UI wiring (source checks) ----------------------------------------------------------------------
test('list page: one API call, confirm before delete, archive actions gated, no per-row signed URLs', () => {
  const page = src('app/packets/page.js');
  assert.match(page, /api\('\/api\/packets'\)/);
  assert.doesNotMatch(page, /from\('packets'\)|from\('company_profiles'\)|createSignedUrl/);
  assert.match(page, /window\.confirm\(`Delete/);
  assert.match(page, /r\.canManage &&/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /\{r\.hint && /);
  assert.doesNotMatch(src('app/lib/packetList.js'), /createSignedUrl|download\(/);
  const mapper = src('app/packets/PacketMapper.js');
  assert.match(mapper, /ADD_FIELD_HINT/);
  assert.doesNotMatch(mapper, /on the review step/);
});
