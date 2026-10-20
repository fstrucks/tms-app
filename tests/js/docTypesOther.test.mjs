import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCAN_DOC_TYPES, uploadButtonLabel, otherDocType, docTypeLabel, UPLOAD_LABEL_MAX } from '../../app/lib/docTypes.js';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));

test('uploadButtonLabel per type, one line at 390px', () => {
  const want = { ratecon: 'Upload Rate Confirmation', bol: 'Upload BOL', pod: 'Upload POD', lumper_receipt: 'Upload Lumper Receipt',
    w9: 'Upload W-9', coi: 'Upload COI', mc_authority: 'Upload MC Authority', other: 'Upload Document', nope: 'Upload Document' };
  for (const [k, v] of Object.entries(want)) assert.equal(uploadButtonLabel(k), v, k);
  for (const t of SCAN_DOC_TYPES) assert.ok(uploadButtonLabel(t.id).length <= UPLOAD_LABEL_MAX);
});

test('Other is last; stored as other:<name>, trimmed, max 40', () => {
  assert.equal(SCAN_DOC_TYPES.at(-1).id, 'other');
  assert.equal(otherDocType('  Scale   ticket '), 'other:Scale ticket');
  assert.equal(otherDocType('   '), null);
  assert.equal(otherDocType('x'.repeat(60)).length, 'other:'.length + 40);
});

test('docTypeLabel shows custom names and known labels', () => {
  assert.equal(docTypeLabel('other:Scale ticket'), 'Scale ticket');
  assert.equal(docTypeLabel('bol'), 'Bill of lading');
  assert.equal(docTypeLabel('rate_confirmation'), 'Rate confirmation');
  assert.equal(docTypeLabel('some_thing'), 'some thing');
  assert.equal(docTypeLabel(null), '');
});

test('Scanner Other input + validation; list pages use docTypeLabel', () => {
  const sc = read('../../app/components/scanner/Scanner.js');
  assert.match(sc, /\{isOther && \(\s*<label[\s\S]*?Name<\/span>\s*<input ref=\{otherRef\} type="text"[^\n]*maxLength=\{OTHER_MAX\} required/);
  assert.match(sc, /const savedType = isOther \? otherDocType\(otherName\) : docType;\s*if \(!savedType\) return setMsg/);
  assert.match(sc, /docType: savedType, loadId/);
  assert.match(read('../../app/documents/page.js'), /\{docTypeLabel\(d\.doc_type\)\}/);
  assert.match(read('../../app/loads/[id]/page.js'), /\{d\.label \|\| docTypeLabel\(d\.doc_type\)\}/); // PR #110: server label first
});

test('Documents copy + Rate Confirmation label present', () => {
  const d = read('../../app/documents/page.js');
  assert.match(d, />Document Upload<\/h1>/);
  assert.match(d, />Upload Rate Confirmations, POD, BOL and other documents<\/legend>/);
  assert.match(read('../../app/components/scanner/Scanner.js'), /label: 'Rate Confirmation'/);
});
