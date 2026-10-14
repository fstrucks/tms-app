// Documents "Scan document" (4th Upload option): Type defaults to Rate con -> rate-con upload path; BOL/POD -> save-to-load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rateConScanFileName } from '../../app/lib/scan.js';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
const menu = read('../../app/components/UploadMenu.js');
const scanner = read('../../app/components/scanner/Scanner.js');
const docs = read('../../app/documents/page.js');
const load = read('../../app/loads/[id]/page.js');
const expenses = read('../../app/expenses/page.js');

test('rateConScanFileName: RateCon_YYYY-MM-DD_HHMM.pdf', () => {
  assert.equal(rateConScanFileName(new Date(2026, 9, 13, 7, 5)), 'RateCon_2026-10-13_0705.pdf');
});

test('UploadMenu: one scan option, Scan document, 4th after Take photo / Photo library / Files', () => {
  assert.match(menu, /const options = onScan \? \[\.\.\.OPTIONS, SCAN\] : OPTIONS;/);
  assert.match(menu, /label: 'Scan document'/);
  assert.doesNotMatch(menu, /ratecon|Scan rate con|onRateConScan/i);
});

test('Scanner: Rate con is first + default only with allowRateCon; hides Load picker; Use as rate con', () => {
  assert.match(scanner, /RATECON_TYPE = \{ id: 'ratecon', label: 'Rate con' \}/);
  assert.match(scanner, /typeOptions = allowRateCon \? \[RATECON_TYPE, \.\.\.SCAN_DOC_TYPES\] : SCAN_DOC_TYPES/);
  assert.match(scanner, /useState\(allowRateCon \? RATECON_TYPE\.id : 'bol'\)/);
  assert.match(scanner, /\{!rateCon && \(\s*<label[\s\S]*?No load/);
  assert.match(scanner, /\{rateCon \? 'Use as rate con' : 'Save PDF'\}/);
  assert.match(scanner, /rateCon \? rateConScanFileName\(\) : scanFileName\(docType\)/);
});

test('Documents: one scanner; ratecon -> uploadRateCon path, BOL/POD -> uploadScan', () => {
  assert.match(docs, /<UploadMenu [^>]*onScan=\{openScanner\}/);
  assert.match(docs, /<Scanner allowRateCon initialFiles=\{scanFiles\}/);
  assert.match(docs, /if \(scan\.docType === 'ratecon'\) return applyRateConScan\(scan\);\s*const err = await uploadScan/);
  const fn = docs.slice(docs.indexOf('function applyRateConScan'), docs.indexOf('async function saveScan'));
  assert.match(fn, /pickFile\(pdf\);\s*uploadRateCon\(pdf\);/);
  assert.doesNotMatch(fn, /uploadScan/);
  assert.match(docs, />Upload a rate confirmation, or scan a rate con, BOL or POD</);
});

test('Load page scanner stays BOL/POD (no allowRateCon); Expenses has no scan', () => {
  assert.match(load, /Scan BOL\/POD/);
  assert.doesNotMatch(load, /allowRateCon/);
  assert.doesNotMatch(expenses, /onScan/);
});

test('Scanner header: one line with ellipsis; colour toggle hidden during discard prompt', () => {
  assert.match(scanner, /flexWrap: 'nowrap'/);
  assert.match(scanner, /minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' \}\}>Scan document/);
  assert.match(scanner, /aria-label="Colour" style=\{\{ display: askDiscard \? 'none' : 'inline-flex'/);
});
