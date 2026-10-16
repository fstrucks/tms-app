import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeApi, SIGNED_OUT_MSG } from '../../app/lib/packetApi.js';
import { makeDraft, saveDraft, loadDraft, applyDraft, draftKey } from '../../app/lib/packetDraft.js';
import { fillBlockers } from '../../app/lib/packetFillReady.js';
import { packetAccess, isAuthRejection } from '../../app/lib/packetServer.js';
import { GET as SIGS } from '../../app/api/packets/[id]/signatures/route.js';
import { POST as SIGN, DELETE as CLEAR } from '../../app/api/packets/[id]/sign/route.js';
import { encryptField } from '../../app/lib/packetCrypto.js';
import { deflateSync } from 'node:zlib';

const PID = '00000000-0000-4000-8000-0000000000a2';
const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// ---- sign-out root cause: refresh + retry; only a 2nd 401 is "signed out"
function fakeAuth({ tokens = ['old', 'new'], refreshOk = true } = {}) {
  let i = 0; const calls = [];
  return { calls, auth: {
    getSession: async () => { calls.push('get'); return { data: { session: { access_token: tokens[Math.min(i, tokens.length - 1)] } } }; },
    refreshSession: async () => { calls.push('refresh'); if (!refreshOk) return { data: { session: null } }; i++; return { data: { session: { access_token: tokens[Math.min(i, tokens.length - 1)] } } }; },
  } };
}
test('api: expired token → refresh once and retry (no sign-out); real sign-out → signedOut message', async () => {
  const a = fakeAuth(); const seen = [];
  const api = makeApi(() => a.auth, { fetchImpl: async (u, o) => { seen.push(o.headers.Authorization); return o.headers.Authorization === 'Bearer new' ? new Response('{"ok":1}') : new Response('{"error":"Sign in again."}', { status: 401 }); } });
  assert.deepEqual(await api.call('/api/x'), { ok: 1 });
  assert.deepEqual(seen, ['Bearer old', 'Bearer new']); assert.ok(a.calls.includes('refresh'));
  const b = fakeAuth({ tokens: ['old'], refreshOk: false });
  const api2 = makeApi(() => b.auth, { fetchImpl: async () => new Response('{}', { status: 401 }) });
  const r = await api2.call('/api/x');
  assert.equal(r.signedOut, true); assert.equal(r.error, SIGNED_OUT_MSG); assert.equal(r.status, 401);
  const api3 = makeApi(() => b.auth, { fetchImpl: async () => new Response('{"error":"Couldn’t check your sign-in just now. Try again."}', { status: 503 }) });
  assert.equal((await api3.call('/api/x')).signedOut, undefined);
  const api4 = makeApi(() => b.auth, { fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.match((await api4.call('/api/x')).error, /Network/);
});
test('server: Supabase Auth outage is 503 (retry), not 401 (signed out)', async () => {
  const req = new Request('http://x', { headers: { authorization: 'Bearer t' } });
  const sb = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { id: PID, owner_id: 'o' } }) }) };
  const mk = (res) => () => ({ auth: { getUser: async () => res }, rpc: async () => ({ data: 'owner' }) });
  assert.equal((await packetAccess(req, PID, { sb, mkUserClient: mk({ data: { user: null }, error: { status: 0, message: 'fetch failed' } }) })).status, 503);
  assert.equal((await packetAccess(req, PID, { sb, mkUserClient: mk({ data: { user: null }, error: { status: 502, message: 'Bad gateway' } }) })).status, 503);
  assert.equal((await packetAccess(req, PID, { sb, mkUserClient: mk({ data: { user: null }, error: { status: 403, message: 'invalid JWT: token is expired' } }) })).status, 401);
  assert.equal((await packetAccess(req, PID, { sb, mkUserClient: mk({ data: { user: { id: 'u' } }, error: null }) })).role, 'owner');
  assert.equal(isAuthRejection({ status: 500, message: 'jwt something' }), false);
});

// ---- unsaved edits survive sign-out; secrets never stored
function mem() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; }
test('draft: keeps unsaved edits (incl. moved box + date value), drops typed bank numbers, restores over server fields', () => {
  const st = mem();
  const fields = [
    { id: 'a', page: 1, box: [10, 10, 99, 30], dirty: true, kind: 'date', profile_key: 'date', value: '10/16/2026' },
    { id: 'b', page: 1, box: [1, 1, 9, 9], dirty: true, valueDirty: true, profile_key: 'bank_account', value: '000123456789' },
    { id: 'tmp-1', page: 1, box: [5, 5, 50, 20], dirty: true, kind: 'text', value: 'FAKE' },
    { id: 'c', page: 1, box: [0, 0, 5, 5] },
  ];
  saveDraft(st, PID, fields, ['z']);
  assert.ok(!st.getItem(draftKey(PID)).includes('000123456789'));
  const d = loadDraft(st, PID);
  const r = applyDraft([{ id: 'a', box: [0, 0, 1, 1] }, { id: 'b' }, { id: 'c' }, { id: 'z' }], d);
  assert.deepEqual(r.fields.find((f) => f.id === 'a').box, [10, 10, 99, 30]);
  assert.equal(r.fields.find((f) => f.id === 'a').value, '10/16/2026');
  assert.ok(r.fields.some((f) => f.id === 'tmp-1')); assert.ok(!r.fields.some((f) => f.id === 'z'));
  assert.equal(r.secretsDropped, 1); assert.equal(r.restored, 4);
  saveDraft(st, PID, [{ id: 'c' }], []); assert.equal(st.getItem(draftKey(PID)), null);
  assert.equal(makeDraft([], []), null);
});

test('fill readiness: reasons up front (unsaved, bank, unsigned) and ready when clear', () => {
  const f = [{ id: 's', page: 2, kind: 'signature' }, { id: 'b', page: 1, profile_key: 'bank_routing', value: '011000015', confirmed: false }];
  assert.deepEqual(fillBlockers(f, { dirty: true }).map((x) => x.code), ['unsaved', 'bank', 'unsigned']);
  assert.equal(fillBlockers(f).find((x) => x.code === 'unsigned').field.id, 's');
  assert.deepEqual(fillBlockers([{ id: 's', kind: 'signature', signed: true }, { ...f[1], confirmed: true }]), []);
  assert.equal(fillBlockers([])[0].code, 'no_fields');
});

// ---- signature preview URLs + clear + re-sign cleanup
function crc(buf) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }
const PNG = (() => { const h = Buffer.alloc(13); h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 6; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 255]))), chunk('IEND', Buffer.alloc(0))]); })();
function fakeSb(fields) {
  const tbl = { packets: [{ id: PID, owner_id: 'owner1', file_path: 'owner1/packets/x.pdf' }], packet_fields: fields };
  const store = {}, removed = [];
  const from = (name) => { const st = { op: 'select', f: [] }; const run = () => { const rows = tbl[name].filter((r) => st.f.every(([k, v]) => r[k] === v)); if (st.op === 'update') rows.forEach((r) => Object.assign(r, st.p)); return { data: st.one ? rows[0] || null : rows, error: null }; };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, order() { return b; }, update(p) { st.op = 'update'; st.p = p; return b; }, maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve(run()).then(res, rej) }; return b; };
  const storage = { from: () => ({ upload: async (p, b) => { store[p] = b; return { error: null }; }, remove: async (ps) => { removed.push(...ps); return {}; }, createSignedUrl: async (p) => ({ data: { signedUrl: `https://x/${p}` } }) }) };
  return { from, storage, tbl, store, removed };
}
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } }, error: null }) }, rpc: async () => ({ data: role }) });
const rq = (m, body) => new Request(`http://x/api/packets/${PID}/sign`, { method: m, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const signedRows = () => [
  { id: 's1', packet_id: PID, kind: 'signature', profile_key: 'signature', page: 1, box: [0, 0, 9, 9], signature_path: `owner1/packets/signatures/${PID}/s1-1.png`, signer_name: 'Test Owner (FAKE)', signed_at: '2026-10-16T18:00:00Z', signed_by: 'u-owner' },
  { id: 's2', packet_id: PID, kind: 'signature', profile_key: 'signature', page: 1, box: [0, 0, 9, 9], signature_path: 'someone-else/evil.png' },
  { id: 'b', packet_id: PID, kind: 'text', profile_key: 'bank_account', page: 1, box: [0, 0, 9, 9], value_ciphertext: encryptField('000123456789', Buffer.alloc(32, 1)) },
];
test('signatures route: members (drivers too) get signed URLs for owner-folder PNGs only', async () => {
  const sb = fakeSb(signedRows());
  const r = await SIGS(new Request('http://x', { headers: { authorization: 'Bearer t' } }), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver') } });
  const j = await r.json();
  assert.deepEqual(Object.keys(j.urls), ['s1']); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await SIGS(new Request('http://x', { headers: { authorization: 'Bearer t' } }), { params: { id: PID }, deps: { sb, mkUserClient: uc(null) } })).status, 404);
});
test('clear signature: editors only; removes PNG + signer/name/date; re-sign deletes the old PNG', async () => {
  const sb = fakeSb(signedRows());
  assert.equal((await CLEAR(rq('DELETE', { fieldId: 's1' }), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver') } })).status, 403);
  const r = await CLEAR(rq('DELETE', { fieldId: 's1' }), { params: { id: PID }, deps: { sb, mkUserClient: uc('dispatcher') } });
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.cleared, 1); assert.deepEqual(sb.removed, [`owner1/packets/signatures/${PID}/s1-1.png`]);
  const s1 = sb.tbl.packet_fields[0]; assert.equal(s1.signature_path, null); assert.equal(s1.signer_name, null); assert.equal(s1.signed_at, null);
  assert.equal(j.fields.find((f) => f.id === 's1').signed, false);
  assert.equal((await CLEAR(rq('DELETE', { fieldId: 's1' }), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner') } })).status, 404);
  // re-sign
  const sb2 = fakeSb(signedRows());
  const res = await SIGN(rq('POST', { fieldId: 's1', dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, signerName: 'Test Owner (FAKE)', signedAt: new Date().toISOString(), method: 'draw' }), { params: { id: PID }, deps: { sb: sb2, mkUserClient: uc('owner'), ts: 2 } });
  assert.equal(res.status, 200);
  assert.deepEqual(sb2.removed, [`owner1/packets/signatures/${PID}/s1-1.png`]);
  assert.equal(sb2.tbl.packet_fields[0].signature_path, `owner1/packets/signatures/${PID}/s1-2.png`);
});

test('mapper: 44px resize target outside the box, rAF drag, touch-action while dragging, image preview, Re-sign/Clear, no stray Done for drivers', () => {
  const m = src('app/packets/PacketMapper.js');
  assert.match(m, /right: -22, bottom: -22, width: 44, height: 44/);
  assert.match(m, /requestAnimationFrame/);
  assert.match(m, /touchAction: dragging \? 'none' : 'auto'/);
  assert.match(m, /<img src=\{sigUrls\[f\.id\]\}/);
  assert.match(m, />Re-sign</); assert.match(m, />Clear signature</);
  assert.match(m, /\(canEdit \|\| !\(f\.kind === 'signature' \|\| f\.profile_key === 'signature'\)\) && <button style=\{s\.btn\} onClick=\{onClose\}>Done/);
  assert.match(m, /Shorter/); assert.match(m, /Taller/); assert.match(m, /Width in inches/);
  assert.match(m, /disabled=\{busy \|\| fillWhy\.length > 0\}/);
  assert.match(m, /You were signed out/);
  const page = src('app/packets/[id]/page.js');
  assert.match(page, /makeApi\(/); assert.match(page, /loadSignatures=/); assert.match(page, /onClearSig=/);
});
