// Documents "Scan document" (4th Upload option): Rate con is offered first -> rate-con upload path; BOL/POD -> save-to-load.
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

test('Scanner: Rate con is first only with allowRateCon (no default type); hides Load picker; Use as rate con', () => {
  assert.match(scanner, /RATECON_TYPE = \{ id: 'ratecon', label: 'Rate Confirmation' \}/);
  assert.match(scanner, /typeOptions = allowRateCon \? \[RATECON_TYPE, \.\.\.baseTypes\] : baseTypes/);
  assert.match(scanner, /const \[docType, setDocType\] = useState\(''\);/);
  assert.match(scanner, /\{!rateCon && \(\s*<label[\s\S]*?No load/);
  assert.match(scanner, /onClick=\{tryUpload\}>\{uploadButtonLabel\(docType\)\}<\/button>/);
  assert.match(scanner, /rateCon \? rateConScanFileName\(\) : scanFileName\(docType\)/);
});

test('Documents: one scanner; ratecon -> uploadRateCon path, BOL/POD -> uploadScan', () => {
  assert.match(docs, /<UploadMenu [^>]*onScan=\{openScanner\}/);
  assert.match(docs, /<Scanner allowRateCon typeIds=\{DOCUMENTS_SCAN_TYPE_IDS\} initialFiles=\{scanFiles\}/); // PR #84: no company types
  assert.match(docs, /if \(scan\.docType === 'ratecon'\) return applyRateConScan\(scan\);\s*const err = await uploadScan/);
  const fn = docs.slice(docs.indexOf('function applyRateConScan'), docs.indexOf('async function saveScan'));
  assert.match(fn, /pickFile\(pdf\);\s*uploadRateCon\(pdf\);/);
  assert.doesNotMatch(fn, /uploadScan/);
  assert.match(docs, />Upload Rate Confirmations, POD, BOL and other documents</);
  assert.match(docs, /<h1[^>]*>Document Upload<\/h1>/);
});

test('Load page scanner: Scan document (BOL/POD/lumper/scale ticket, no allowRateCon); Expenses has no scan', () => {
  assert.match(load, /Scan document/); // PR #110: scale tickets too
  assert.doesNotMatch(load, /allowRateCon/);
  assert.doesNotMatch(expenses, /onScan/);
});

test('Scanner header: one line with ellipsis; colour toggle hidden during discard prompt', () => {
  assert.match(scanner, /flexWrap: 'nowrap'/);
  assert.match(scanner, /minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' \}\}>Scan document/);
  assert.match(scanner, /aria-label="Colour" style=\{\{ display: askDiscard \? 'none' : 'inline-flex'/);
});

test('Scanner footer: prominent "＋ Add page" (camera, label-for mounted input) after the first page, appends', () => {
  assert.match(scanner, /<label htmlFor=\{ids\.camera\}[^>]*>\{n \? '＋ Add page' : '📷 Take photo'\}<\/label>/);
  assert.match(scanner, /<label htmlFor=\{ids\.choose\}[^>]*>\{n \? '🖼️ Choose photo' : '🖼️ Choose photos'\}<\/label>/);
  // camera input appends (no replaceAt) and is visually hidden, not display:none
  assert.match(scanner, /id=\{ids\.camera\}[^\n]*style=\{VISUALLY_HIDDEN\}[^\n]*onChange=\{\(e\) => addFiles\(takeFiles\(e\)\)\}/);
  // footer order (Marc 10/15): Document type (+Load) first, then Add page / Choose, then full-width primary
  const footer = scanner.slice(scanner.indexOf('<footer'), scanner.indexOf('</footer>'));
  assert.ok(footer.indexOf('Document type') < footer.indexOf('ids.camera'));
  assert.ok(footer.indexOf('ids.camera') < footer.indexOf('uploadButtonLabel(docType)'));
  assert.match(footer, /\.\.\.primary, flex: '1 1 100%'/);
});
