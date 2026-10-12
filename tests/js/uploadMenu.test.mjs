// Regression guard for the iOS Safari "Upload option does nothing" bug (source-level; no DOM runner here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../../app/components/UploadMenu.js', import.meta.url), 'utf8');
const src = raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // drop comment lines

test('UploadMenu: options are <label htmlFor> tied to the file inputs', () => {
  assert.match(src, /<label[\s\S]{0,120}?htmlFor=\{`\$\{menuId\}-\$\{o\.id\}`\}/);
  assert.match(src, /<input[\s\S]*?id=\{`\$\{menuId\}-\$\{o\.id\}`\}/);
});

test('UploadMenu: file inputs are visually hidden, not display:none', () => {
  assert.doesNotMatch(src, /display:\s*'none'/);
  assert.match(src, /style=\{VISUALLY_HIDDEN\}/);
});

test('UploadMenu: menu does not close synchronously before the tap activates the input', () => {
  assert.match(src, /setTimeout\(\(\) => setOpen\(false\), 0\)/);
  // The only .click() is the keyboard path, called synchronously in the key handler.
  assert.equal((src.match(/\.click\(\)/g) || []).length, 1);
  assert.match(src, /arm\(id\)\?\.click\(\)/);
});

test('UploadMenu: focusout ignores relatedTarget=null (iOS tap)', () => {
  assert.match(src, /open && e\.relatedTarget && wrapRef\.current/);
});
