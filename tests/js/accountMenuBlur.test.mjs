import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldCloseOnBlur } from '../../app/lib/menuBlur.js';

test('blur during a press inside the menu does not close it (Safari: click would be lost)', () => {
  assert.equal(shouldCloseOnBlur({ open: true, focusStaysInside: false, pressInside: true }), false);
});
test('focus leaving by keyboard (Tab) still closes', () => {
  assert.equal(shouldCloseOnBlur({ open: true, focusStaysInside: false, pressInside: false }), true);
});
test('focus moving between items keeps it open; closed menu never re-closes', () => {
  assert.equal(shouldCloseOnBlur({ open: true, focusStaysInside: true, pressInside: false }), false);
  assert.equal(shouldCloseOnBlur({ open: false, focusStaysInside: false, pressInside: false }), false);
});
test('AccountMenu tracks presses on the wrapper and uses the helper on blur', () => {
  const src = readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');
  assert.match(src, /onPointerDown=\{\(\) => \{ pressRef\.current = true;/);
  assert.match(src, /pointercancel/);
  assert.match(src, /shouldCloseOnBlur\(\{ open, focusStaysInside: .*pressInside: pressRef\.current \}\)/);
  assert.match(src, /document\.addEventListener\('pointerdown', onDown\)/); // outside presses still close
});
