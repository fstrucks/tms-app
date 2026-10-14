// PR #47 QA fixes: auto upload after scan, equipment extraction, page-added status text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pagesAddedNote } from '../../app/lib/scan.js';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
const docs = read('../../app/documents/page.js');
const route = read('../../app/api/extract/route.js');
const scanner = read('../../app/components/scanner/Scanner.js');

test('pagesAddedNote: names page numbers and total', () => {
  assert.equal(pagesAddedNote(1, 1), 'Page 1 added (1 page total).');
  assert.equal(pagesAddedNote(1, 2), 'Page 2 added (2 pages total).');
  assert.equal(pagesAddedNote(3, 5), 'Pages 3–5 added (5 pages total).');
  assert.equal(pagesAddedNote(1, 4, 1), 'Page 2 replaced.');
  assert.equal(pagesAddedNote(0, 3), '');
  assert.match(scanner, /notes\.push\(pagesAddedNote\(added\.length, next\.length, replaceAt\)\)/);
});

test('Scan rate con uploads + extracts immediately via the same uploadRateCon as the Upload button', () => {
  const apply = docs.slice(docs.indexOf('function applyRateConScan'), docs.indexOf('async function saveScan'));
  assert.match(apply, /pickFile\(pdf\);\s*uploadRateCon\(pdf\);/);
  assert.match(docs, /async function handleUpload\(e\) \{\s*e\.preventDefault\(\);\s*const form = e\.target;\s*if \(await uploadRateCon\(file\)\) form\.reset\(\);/);
  const up = docs.slice(docs.indexOf('async function uploadRateCon'), docs.indexOf('async function openScanner'));
  assert.match(up, /File is too large/);
  assert.match(up, /Upload failed: /);
  assert.match(up, /extract\(inserted\.id\)/);
  assert.doesNotMatch(up, /e\.target/);
});

test('Extraction asks for equipment_type; card shows Equipment', () => {
  assert.match(route, /'rate', 'equipment_type', 'notes'\]/);
  assert.match(route, /equipment_type: \{ \.\.\.str, description:/);
  assert.match(docs, /\['Equipment', x\.equipment_type\]/);
  assert.match(docs, /\['Shipper', fmtParty\(x\.shipper\)\]/);
});
