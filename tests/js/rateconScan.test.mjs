// "Scan rate con" (4th Upload option on Documents): scanner PDF goes through the rate-con pickFile path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rateConScanFileName } from '../../app/lib/scan.js';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
const menu = read('../../app/components/UploadMenu.js');
const scanner = read('../../app/components/scanner/Scanner.js');
const docs = read('../../app/documents/page.js');

test('rateConScanFileName: RateCon_YYYY-MM-DD_HHMM.pdf', () => {
  assert.equal(rateConScanFileName(new Date(2026, 9, 13, 7, 5)), 'RateCon_2026-10-13_0705.pdf');
});

test('UploadMenu: Scan rate con is listed after Take photo, Photo library, Files / PDF', () => {
  assert.match(menu, /const RATECON_SCAN = \{ id: 'ratecon-scan'[^}]*accept: 'image\/\*', capture: 'environment', multiple: true \}/);
  assert.match(menu, /const options = \[\.\.\.\(onScan \? \[SCAN\] : \[\]\), \.\.\.OPTIONS, \.\.\.\(onRateConScan \? \[RATECON_SCAN\] : \[\]\)\];/);
  assert.match(menu, /else if \(o\.id === 'ratecon-scan'\) \{ if \(all\.length\) onRateConScan\(all\); \}/);
});

test('Scanner rateCon mode: no doc type / load pickers, returns only the PDF', () => {
  assert.match(scanner, /rateCon = false, onClose, onSave \}/);
  assert.match(scanner, /\{!rateCon && \(<>[\s\S]*aria-label="Document type"[\s\S]*No load[\s\S]*<\/>\)\}/);
  assert.match(scanner, /onSave\(rateCon \? \{ file \} : \{ file, docType, loadId: loadId \|\| null \}\)/);
  assert.match(scanner, /rateCon \? rateConScanFileName\(\) : scanFileName\(docType\)/);
});

test('Documents: rate-con scan PDF goes through pickFile (same as Files / PDF), not uploadScan', () => {
  assert.match(docs, /onScan=\{openScanner\} onRateConScan=\{setRateConScanFiles\}/);
  assert.match(docs, /<Scanner rateCon initialFiles=\{rateConScanFiles\}.*onSave=\{applyRateConScan\}/);
  const fn = docs.slice(docs.indexOf('function applyRateConScan'), docs.indexOf('async function saveScan'));
  assert.match(fn, /pickFile\(pdf\)/);
  assert.doesNotMatch(fn, /uploadScan/);
});

test('Expenses menu unchanged (no scan options)', () => {
  const exp = read('../../app/expenses/page.js');
  assert.doesNotMatch(exp, /onScan|onRateConScan/);
});
