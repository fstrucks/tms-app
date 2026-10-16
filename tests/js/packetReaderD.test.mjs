import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { detectPage } from '../../app/lib/packetDetect.js';
import { abaValid, checkValue } from '../../app/lib/packetValues.js';
import { boxToPdf, fillPacket } from '../../app/lib/packetFill.js';
import { buildPacketFields } from '../../app/lib/packetFields.js';
import { createPacketReader } from '../../app/lib/packetReader.js';

const page = JSON.parse(readFileSync(new URL('../fixtures/packets/fake-page.json', import.meta.url)));

test('detect: labels, kinds, underline + full-width skip, checkbox dedupe/ink', () => {
  const f = detectPage(page);
  assert.deepEqual(f.map((x) => [x.kind, x.label]), [
    ['text', 'Legal Name:'], ['text', 'MC Number:'], ['text', 'Routing #:'], ['signature', 'Signature:'], ['date', 'Date:'], ['checkbox', 'ACH payment'],
  ]);
  assert.deepEqual(f[0].box, [240, 292, 740, 322]);
  assert.equal(f[0].id, 'p1-f0');
});

test('values: ABA checksum, formats, bank always needs confirm', () => {
  assert.equal(abaValid('011000015'), true); // published test-style routing number
  assert.equal(abaValid('011000016'), false);
  assert.deepEqual(checkValue('bank_routing', '011000015'), { ok: true, needs_confirm: true });
  assert.equal(checkValue('bank_account', '0000000000').needs_confirm, true);
  assert.equal(checkValue('mc_number', 'MC-000000').ok, true);
  assert.equal(checkValue('dot_number', '12').ok, false);
  assert.equal(checkValue('ein', '00-0000000').ok, true);
  assert.equal(checkValue('email', 'bad').ok, false);
  assert.equal(checkValue('legal_name', '').message, 'Missing');
});

const mockReader = (map, sent) => createPacketReader({ apiKey: 'test-key', transport: async ({ body }) => {
  sent.push(body);
  return { fields: JSON.parse(body.messages[1].content).map((f) => ({ id: f.id, profile_key: map[f.label] || 'unknown', confidence: map[f.label] ? 0.9 : 0.2 })) };
} });

test('build fields: model names, bank flagged, only labels/positions sent, low confidence counted', async () => {
  const sent = [];
  const reader = mockReader({ 'Legal Name:': 'legal_name', 'MC Number:': 'mc_number', 'Routing #:': 'bank_routing', 'Signature:': 'signature', 'Date:': 'date' }, sent);
  const { rows, summary } = await buildPacketFields({ packetId: 'pk', ownerId: 'ow', pages: [page], reader });
  assert.equal(summary.detected, 6); assert.equal(summary.named, true); assert.equal(summary.low_confidence, 1);
  const r = rows.find((x) => x.profile_key === 'bank_routing');
  assert.equal(r.needs_confirm, true); assert.equal(r.source, 'model');
  assert.equal(rows.find((x) => x.kind === 'checkbox').profile_key, null);
  const keys = new Set(JSON.parse(sent[0].messages[1].content).flatMap(Object.keys));
  assert.deepEqual([...keys].sort(), ['box', 'id', 'kind', 'label', 'page']);
  assert.equal(sent[0].model, 'gpt-4.1-mini');
});

test('build fields: no key or model error → local rows for manual mapping', async () => {
  const a = await buildPacketFields({ packetId: 'pk', ownerId: 'ow', pages: [page], reader: createPacketReader({ apiKey: '' }) });
  assert.equal(a.summary.named, false); assert.ok(a.rows.every((r) => r.source === 'local' && r.profile_key === null));
  const bad = createPacketReader({ apiKey: 'k', transport: async () => { throw new Error('reader http 500'); } });
  const b = await buildPacketFields({ packetId: 'pk', ownerId: 'ow', pages: [page], reader: bad });
  assert.equal(b.summary.error, 'reader http 500'); assert.equal(b.rows.length, 6);
});

test('fill: px→pt conversion, draws text/checkbox, skips signature, blocks unconfirmed bank', async () => {
  assert.deepEqual(boxToPdf([200, 200, 400, 300], 792, 200), { x: 72, y: 684, w: 72, h: 36 });
  const d = await PDFDocument.create(); d.addPage([612, 792]); const pdf = await d.save();
  const fields = [
    { id: 'a', page: 1, kind: 'text', box: [240, 292, 740, 322], value: 'Test Trucking Co (FAKE)' },
    { id: 'b', page: 1, kind: 'checkbox', box: [105, 805, 125, 825], value: true },
    { id: 'c', page: 1, kind: 'signature', box: [220, 692, 620, 722], value: 'x' },
    { id: 'd', page: 1, kind: 'text', box: [220, 492, 520, 522], value: '011000015', needs_confirm: true, confirmed: true },
  ];
  const out = await fillPacket(pdf, fields);
  assert.equal(out.drawn, 3);
  assert.ok((await PDFDocument.load(out.bytes)).getPageCount() === 1);
  await assert.rejects(fillPacket(pdf, [{ ...fields[3], confirmed: false }]), /needs user confirmation/);
});
