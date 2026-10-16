import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MANUAL_REASONS, MANUAL_REASONS_VIEW, manualReasonText } from '../../app/lib/packetMapperModel.js';
import { PACKET_STATUS_LABELS, packetStatusLabel, isPendingStatus, POLL_MS } from '../../app/lib/packetStatus.js';
const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('view-only users never get editing instructions, for every manual_reason', () => {
  assert.deepEqual(Object.keys(MANUAL_REASONS_VIEW).sort(), Object.keys(MANUAL_REASONS).sort());
  for (const r of Object.keys(MANUAL_REASONS)) {
    const t = manualReasonText(r, false);
    assert.doesNotMatch(t, /Add field|Tap|Pick a name|by hand/i, r);
    assert.match(t, /owner, dispatcher or management/, r);
  }
  assert.equal(manualReasonText('no_text_layer', false), 'This packet was scanned, so fields need to be placed by the owner, dispatcher or management.');
  assert.match(manualReasonText('no_text_layer', true), /Add field/);
  assert.equal(manualReasonText(null, false), null);
  assert.match(manualReasonText('brand_new', false), /owner, dispatcher or management/);
});

test('list and packet page use the same status labels', () => {
  assert.equal(packetStatusLabel('review'), 'Ready to fill out');
  for (const s of Object.keys(PACKET_STATUS_LABELS)) assert.ok(packetStatusLabel(s));
  assert.equal(packetStatusLabel('weird'), 'weird');
  for (const f of ['app/packets/page.js', 'app/packets/PacketMapper.js']) {
    assert.match(src(f), /packetStatusLabel\(/, f);
    assert.doesNotMatch(src(f), /'ready to fill out'/, f);
  }
  assert.match(src('app/packets/PacketMapper.js'), /manualReasonText\(packet\.manual_reason, canEdit\)/);
});

test('list polls fast only while pending and refreshes when processing returns', () => {
  assert.ok(POLL_MS <= 2000);
  assert.equal(isPendingStatus('processing'), true); assert.equal(isPendingStatus('received'), true); assert.equal(isPendingStatus('review'), false);
  const page = src('app/packets/page.js');
  assert.match(page, /if \(!pending\) return;/);
  assert.match(page, /POLL_MS\)/);
  assert.match(page, /\.then\(\(\) => load\(\)/);
});
