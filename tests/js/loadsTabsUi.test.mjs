// Source-level checks for LoadsTabs (no DOM runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../app/components/LoadsTabs.js', import.meta.url), 'utf8');

test('LoadsTabs: roving tabindex with Arrow/Home/End', () => {
  assert.match(src, /tabIndex=\{on \? 0 : -1\}/);
  for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.match(src, new RegExp(`${k}:`));
  assert.match(src, /onKeyDown=\{onTabKey\}/);
});

test('LoadsTabs: no default-tab flash before ?tab= is parsed', () => {
  assert.match(src, /useState\(null\)/);
  assert.match(src, /if \(tab === null\) return null;/);
});
