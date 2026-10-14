// iOS Safari: scanner/Scan-document file pickers must open via native <label htmlFor> activation
// of a mounted, visually-hidden input (no display:none / hidden attr, no programmatic click on taps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const scanner = strip(readFileSync(new URL('../../app/components/scanner/Scanner.js', import.meta.url), 'utf8'));
const menu = strip(readFileSync(new URL('../../app/components/UploadMenu.js', import.meta.url), 'utf8'));

test('Scanner: Take photo / Choose photos / Retake are labels tied to inputs', () => {
  for (const k of ['camera', 'choose', 'retake']) {
    assert.match(scanner, new RegExp(`<label htmlFor=\\{ids\\.${k}\\}`), k + ' label');
    assert.match(scanner, new RegExp(`<input[^>]*id=\\{ids\\.${k}\\}[^>]*style=\\{VISUALLY_HIDDEN\\}`), k + ' input');
  }
});

test('Scanner: inputs are not display:none / hidden, and no tap-path click()', () => {
  assert.doesNotMatch(scanner, /<input[^>]*\shidden[\s/>]/);
  assert.doesNotMatch(scanner, /display:\s*'none'/);
  assert.doesNotMatch(scanner, /openInput\(/);
  // Only the keyboard handler may call .click().
  assert.equal((scanner.match(/\.click\(\)/g) || []).length, 1);
  assert.match(scanner, /function keyOpen\(e\) \{\s*if \(e\.key !== 'Enter' && e\.key !== ' '\) return;/);
});

test('Scanner: Take photo keeps capture; Choose photos has no capture', () => {
  assert.match(scanner, /id=\{ids\.camera\}[^>]*capture="environment"/);
  assert.doesNotMatch(scanner.match(/<input[^>]*id=\{ids\.choose\}[^>]*>/)[0], /capture/);
});

test('UploadMenu: Scan document uses the same label-for-mounted-input path', () => {
  assert.match(menu, /const SCAN = \{ id: 'scan'[^}]*capture: 'environment'[^}]*multiple: true/);
  assert.match(menu, /const options = \[\.\.\.\(onScan \? \[SCAN\] : \[\]\), \.\.\.OPTIONS/);
  // inputs and labels are both rendered from `options`, so scan gets an id'd, visually hidden input
  assert.match(menu, /\{options\.map\(\(o\) => \(\s*<input[\s\S]*?id=\{`\$\{menuId\}-\$\{o\.id\}`\}[\s\S]*?style=\{VISUALLY_HIDDEN\}/);
  assert.match(menu, /\{options\.map\(\(o, i\) => \([\s\S]*?<label[\s\S]*?htmlFor=\{`\$\{menuId\}-\$\{o\.id\}`\}/);
  assert.match(menu, /if \(o\.id === 'scan'\) \{ if \(all\.length\) onScan\(all\); \}/);
});
