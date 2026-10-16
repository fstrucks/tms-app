import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { extractPdf, itemToWords } from '../../app/lib/packetPdfText.js';
import { detectPacket } from '../../app/lib/packetDetect.js';
import { applyEdit, toClient } from '../../app/lib/packetFieldEdits.js';
import { summarize, placeBox, nudge, buildPatch, updateField, fieldState } from '../../app/lib/packetMapperModel.js';
import { processPacket } from '../../app/lib/packetProcess.js';
import { createPacketReader } from '../../app/lib/packetReader.js';
import { PATCH, GET } from '../../app/api/packets/[id]/fields/route.js';
import { POST as PROCESS } from '../../app/api/packets/[id]/process/route.js';

// ---- fake digital packet (FAKE data only)
async function fakePdf({ text = true } = {}) {
  const d = await PDFDocument.create(); const p = d.addPage([612, 792]); const f = await d.embedFont(StandardFonts.Helvetica);
  if (text) {
    p.drawText('TEST BROKERAGE CARRIER SETUP (FAKE)', { x: 72, y: 740, size: 14, font: f });
    p.drawText('Legal Name:', { x: 72, y: 700, size: 10, font: f }); p.drawLine({ start: { x: 140, y: 698 }, end: { x: 450, y: 698 }, thickness: 1 });
    p.drawText('Routing #: ______________________', { x: 72, y: 670, size: 10, font: f });
    p.drawRectangle({ x: 72, y: 636, width: 9, height: 9, borderWidth: 1, borderColor: rgb(0, 0, 0) }); p.drawText('ACH payment', { x: 86, y: 637, size: 10, font: f });
    p.drawText('Signature:', { x: 72, y: 600, size: 10, font: f }); p.drawRectangle({ x: 130, y: 598, width: 200, height: 0.8, color: rgb(0, 0, 0) });
  } else p.drawRectangle({ x: 50, y: 50, width: 400, height: 600, color: rgb(0.9, 0.9, 0.9) }); // image-like page, no text
  return Buffer.from(await d.save());
}

test('pdf text layer → detector input → fields (lines, underscores, checkbox, signature, dedupe)', async () => {
  const ex = await extractPdf(await fakePdf());
  assert.equal(ex.hasText, true); assert.equal(ex.pageCount, 1); assert.equal(ex.truncated, false);
  assert.deepEqual(ex.pages[0].size.map(Math.round), [1700, 2200]);
  const f = detectPacket(ex.pages);
  assert.deepEqual(f.map((x) => [x.kind, x.label]), [['text', 'Legal Name:'], ['text', 'Routing #:'], ['checkbox', 'ACH payment'], ['signature', 'Signature:']]);
});
test('scan without text layer → hasText false; page cap → truncated', async () => {
  assert.equal((await extractPdf(await fakePdf({ text: false }))).hasText, false);
  const d = await PDFDocument.create(); for (let i = 0; i < 3; i++) d.addPage();
  assert.equal((await extractPdf(Buffer.from(await d.save()), { maxPages: 2 })).truncated, true);
});
test('itemToWords splits words and underscore blanks', () => {
  const r = itemToWords('MC #: ______ ok', 0, 0, 150, 10);
  assert.deepEqual(r.words.map((w) => w.text), ['MC', '#:', 'ok']); assert.equal(r.lines.length, 1); assert.equal(r.lines[0].x, 60);
});

// ---- edits
const enc = (v) => `ct(${v})`;
const base = { id: 'x', page: 1, kind: 'text', box: [10, 10, 200, 40], label: 'Routing #:', profile_key: 'bank_routing', source: 'model', value_ciphertext: null };
test('edits: bank values encrypted with last4, invalid routing rejected, confirm rules', () => {
  assert.match(applyEdit({ value: '011000016' }, base, { userId: 'u', encrypt: enc }).error, /ABA/);
  const r = applyEdit({ value: '011 000 015' }, base, { userId: 'u', encrypt: enc }).row;
  assert.equal(r.value_ciphertext, 'ct(011000015)'); assert.equal(r.value_last4, '0015'); assert.equal(r.value_text, null); assert.equal(r.confirmed_at, null);
  assert.match(applyEdit({ confirm: true }, base, { userId: 'u', encrypt: enc }).error, /Enter the bank number/);
  const c = applyEdit({ confirm: true }, { ...base, value_ciphertext: 'ct' }, { userId: 'u', encrypt: enc, now: 'T' }).row;
  assert.equal(c.confirmed_at, 'T'); assert.equal(c.confirmed_by, 'u');
  // changing value clears confirmation; masked echo keeps it unchanged
  assert.equal(applyEdit({ value: '021000021' }, { ...base, value_ciphertext: 'ct', confirmed_at: 'T' }, { userId: 'u', encrypt: enc }).row.confirmed_at, null);
  assert.equal(applyEdit({ value: '•••0015' }, { ...base, value_ciphertext: 'ct' }, { userId: 'u', encrypt: enc }).row.value_ciphertext, undefined);
  assert.match(applyEdit({ confirm: true, profile_key: 'legal_name' }, base, { userId: 'u', encrypt: enc }).error, /Only bank/);
});
test('edits: secret never moves to plaintext on rename; validation; new field key', () => {
  const r = applyEdit({ profile_key: 'legal_name' }, { ...base, value_ciphertext: 'ct', value_last4: '0015' }, { userId: 'u', encrypt: enc }).row;
  assert.equal(r.value_ciphertext, null); assert.equal(r.value_text, null); assert.equal(r.needs_confirm, false);
  assert.equal(applyEdit({ box: [5, 5, 1, 1] }, base, { userId: 'u', encrypt: enc }).error, 'Bad box');
  assert.equal(applyEdit({ profile_key: 'hack' }, base, { userId: 'u', encrypt: enc }).error, 'Unknown field name');
  assert.equal(applyEdit({ kind: 'blob' }, base, { userId: 'u', encrypt: enc }).error, 'Bad field type');
  const n = applyEdit({ page: 1, kind: 'text', box: [0, 0, 50, 20], value: 'Test Co (FAKE)', profile_key: 'legal_name' }, null, { userId: 'u', encrypt: enc }).row;
  assert.match(n.field_key, /^u-/); assert.equal(n.value_text, 'Test Co (FAKE)'); assert.equal(n.source, 'user');
});
test('toClient never exposes ciphertext; masks bank values', () => {
  const c = toClient({ ...base, value_ciphertext: 'SECRET', value_last4: '0015', confirmed_at: null, needs_confirm: true });
  assert.equal(JSON.stringify(c).includes('SECRET'), false); assert.equal(c.value, '•••0015'); assert.equal(c.has_value, true);
  assert.deepEqual(toClient({ ...base, profile_key: 'dot_number', value_text: '12' }).check.ok, false);
});

// ---- mapper model
test('mapper model: states, placement clamp, nudge, patch building', () => {
  const fs = [{ profile_key: null }, { profile_key: 'bank_routing', confirmed: false }, { profile_key: 'dot_number', check: { ok: false } }, { profile_key: 'legal_name' }];
  assert.deepEqual(summarize(fs), { total: 4, unmapped: 1, confirm: 1, check: 1, ok: 1 });
  assert.deepEqual(placeBox(1600, 5, 1700, 2200), [1140, 0, 1700, 36]);
  assert.deepEqual(nudge([0, 0, 100, 30], -10, 0, -100, 1700, 2200), [0, 0, 40, 30]);
  let f = { id: 'a', page: 1, kind: 'text', box: [0, 0, 10, 10], profile_key: 'bank_routing', value: '•••0015', confirmed: true };
  f = updateField(f, { value: '011000015' }); assert.equal(f.confirmed, false); assert.equal(fieldState(f), 'confirm');
  f = updateField(f, { confirmed: true });
  const t = { id: 'tmp-1', field_key: 'u-1', page: 1, kind: 'text', box: [0, 0, 10, 10], dirty: true };
  const p = buildPatch([f, t, { id: 'z' }], ['tmp-2', 'y']);
  assert.deepEqual(p.deletes, ['y']); assert.equal(p.upserts[0].value, '011000015'); assert.equal(p.upserts[0].confirm, true);
  assert.equal(p.upserts[1].id, undefined); assert.equal(p.upserts[1].field_key, 'u-1'); assert.equal(p.upserts.length, 2);
});

// ---- fake supabase (records calls; enough of the query builder for these routes)
function fakeSb({ packet, fields = [], pdf, claim = true }) {
  const log = [];
  const tbl = { packets: [packet], packet_fields: fields.map((r) => ({ ...r })) };
  const q = (name) => {
    const st = { name, op: 'select', filters: [], payload: null };
    const run = () => {
      log.push(st);
      if (st.op === 'update' && name === 'packets') {
        if (st.payload.status === 'processing' && !claim) return { data: null, error: null };
        Object.assign(tbl.packets[0], st.payload); return { data: tbl.packets[0], error: null };
      }
      if (st.op === 'update') { const id = st.filters.find((f) => f[0] === 'id')?.[1]; const r = tbl[name].find((x) => x.id === id); Object.assign(r, st.payload); return { data: r, error: null }; }
      if (st.op === 'insert' || st.op === 'upsert') { const rows = [].concat(st.payload).map((r, i) => ({ id: `new${tbl[name].length + i}`, ...r })); tbl[name].push(...rows); return { data: rows[0], error: null }; }
      if (st.op === 'delete') { const inF = st.filters.find((f) => f[0] === 'in'); tbl[name] = tbl[name].filter((r) => !(inF ? inF[2].includes(r[inF[1]]) : true)); return { data: null, error: null }; }
      return { data: name === 'packets' ? tbl.packets[0] : tbl[name], error: null };
    };
    const b = {
      select() { return b; }, eq(k, v) { st.filters.push([k, v]); return b; }, in(k, v) { st.filters.push(['in', k, v]); return b; }, or() { return b; }, order() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; }, upsert(p) { st.op = 'upsert'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; },
      maybeSingle: async () => run(), single: async () => run(), then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { tbl, log, from: q, storage: { from: () => ({ download: async () => ({ data: new Blob([pdf || Buffer.from('')]), error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://x/signed' } }) }) } };
}
const PID = '00000000-0000-4000-8000-000000000001';
const pkt = () => ({ id: PID, owner_id: 'owner1', status: 'received', file_path: 'owner1/packets/1-0-test.pdf' });

test('process: digital PDF → named fields saved, status review, bank flagged', async () => {
  const sb = fakeSb({ packet: pkt(), pdf: await fakePdf() });
  const reader = createPacketReader({ apiKey: 'k', transport: async ({ body }) => ({ fields: JSON.parse(body.messages[1].content).map((f) => ({ id: f.id, profile_key: /Routing/.test(f.label) ? 'bank_routing' : /Legal/.test(f.label) ? 'legal_name' : 'unknown', confidence: 0.9 })) }) });
  const out = await processPacket({ sb, packetId: PID, reader });
  assert.equal(out.fields, 4); assert.equal(out.named, true); assert.equal(out.manual, null);
  assert.equal(sb.tbl.packets[0].status, 'review'); assert.equal(sb.tbl.packets[0].has_text_layer, true);
  const bank = sb.tbl.packet_fields.find((r) => r.profile_key === 'bank_routing');
  assert.equal(bank.needs_confirm, true); assert.equal(Math.round(bank.page_w), 1700);
});
test('process: scan → manual no_text_layer; already claimed → skipped; reader timeout → unnamed local rows', async () => {
  const s1 = fakeSb({ packet: pkt(), pdf: await fakePdf({ text: false }) });
  assert.deepEqual(await processPacket({ sb: s1, packetId: PID, reader: createPacketReader({ apiKey: '' }) }), { manual: 'no_text_layer', fields: 0 });
  assert.equal(s1.tbl.packets[0].manual_reason, 'no_text_layer');
  assert.deepEqual(await processPacket({ sb: fakeSb({ packet: pkt(), claim: false }), packetId: PID }), { skipped: true });
  const slow = createPacketReader({ apiKey: 'k', transport: () => new Promise(() => {}) });
  const s3 = fakeSb({ packet: pkt(), pdf: await fakePdf() });
  const o3 = await processPacket({ sb: s3, packetId: PID, reader: slow, budgetMs: 1200 });
  assert.equal(o3.manual, 'timeout'); assert.ok(s3.tbl.packet_fields.every((r) => r.source === 'local'));
});
test('process: bad file → status error (no crash)', async () => {
  const sb = fakeSb({ packet: pkt(), pdf: Buffer.from('not a pdf') });
  const o = await processPacket({ sb, packetId: PID, reader: createPacketReader({ apiKey: '' }) });
  assert.ok(o.error); assert.equal(sb.tbl.packets[0].status, 'error');
});

// ---- routes: auth + role gate
const req = (method, body, token = 't', url = `http://x/api/packets/${PID}/fields`) => new Request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) }, rpc: async () => ({ data: role }) });
const routeField = { id: 'f1', packet_id: PID, field_key: 'p1-f0', page: 1, kind: 'text', label: 'Routing #:', box: [1, 1, 100, 30], profile_key: 'bank_routing', source: 'model', needs_confirm: true, value_ciphertext: 'SECRET', value_last4: '0015' };
const KEY = Buffer.alloc(32, 7);

test('routes: no token 401, non-member 404, driver can GET but not PATCH or force', async () => {
  const sb = fakeSb({ packet: pkt(), fields: [routeField] });
  assert.equal((await GET(req('GET', null, null), { params: { id: PID }, deps: { sb } })).status, 401);
  assert.equal((await GET(req('GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc(null) } })).status, 404);
  const g = await GET(req('GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver') } });
  const j = await g.json(); assert.equal(j.canEdit, false); assert.equal(JSON.stringify(j).includes('SECRET'), false);
  assert.equal((await PATCH(req('PATCH', { upserts: [] }), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver') } })).status, 403);
  assert.equal((await PROCESS(req('POST', null, 't', `http://x/api/packets/${PID}/process?force=1`), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver'), process: async () => ({}) } })).status, 403);
  assert.equal((await PROCESS(req('POST', null, 't', `http://x/api/packets/${PID}/process`), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver'), process: async () => ({ ok: 1 }) } })).status, 200);
});
test('routes: dispatcher saves an encrypted bank value and a new field; bad edit reported', async () => {
  const sb = fakeSb({ packet: pkt(), fields: [routeField] });
  const r = await PATCH(req('PATCH', { upserts: [{ id: 'f1', value: '011000015' }, { page: 1, kind: 'text', box: [0, 0, 300, 30], profile_key: 'legal_name', value: 'Test Co (FAKE)' }, { id: 'f1', box: [9, 9, 1, 1] }] }),
    { params: { id: PID }, deps: { sb, mkUserClient: uc('dispatcher'), key: KEY } });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.errors.length, 1); assert.equal(j.errors[0].error, 'Bad box');
  const saved = sb.tbl.packet_fields.find((x) => x.id === 'f1');
  assert.match(saved.value_ciphertext, /^v1:/); assert.equal(saved.value_ciphertext.includes('011000015'), false); assert.equal(saved.value_last4, '0015');
  assert.equal(sb.tbl.packet_fields.find((x) => x.profile_key === 'legal_name').value_text, 'Test Co (FAKE)');
  assert.equal(JSON.stringify(j).includes('v1:'), false);
});
