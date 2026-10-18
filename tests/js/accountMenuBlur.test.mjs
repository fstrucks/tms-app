import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  assert.match(src, /pressRef\.current = true;/);
  assert.match(src, /pointercancel/);
  assert.match(src, /shouldCloseOnBlur\(\{ open, focusStaysInside: .*pressInside: pressRef\.current \}\)/);
  assert.match(src, /document\.addEventListener\('pointerdown', onDown\)/); // outside presses still close
});

import { pressEndDelay } from '../../app/lib/menuBlur.js';
const menuSrc = () => readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');

test('touch/pen presses stay "inside" briefly after they end (tap focus change comes after touchend)', () => {
  assert.equal(pressEndDelay('mouse'), 0);
  assert.ok(pressEndDelay('touch') >= 300);
  assert.ok(pressEndDelay('pen') >= 300);
  assert.ok(pressEndDelay(undefined) >= 300);
});
test('press tracking covers every pointer type plus touchstart, and ends on up/cancel', () => {
  const src = menuSrc();
  assert.match(src, /onPointerDown=\{\(e\) => notePress\(e\.pointerType \|\| 'mouse'\)\}/);
  assert.match(src, /onTouchStart=\{\(\) => notePress\('touch'\)\}/);
  for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) assert.ok(src.includes(`'${ev}', end`), ev);
});
test('menu container can hold focus so taps on its header/padding keep focus inside', () => {
  assert.match(menuSrc(), /role="menu" aria-label="Account" onKeyDown=\{onKey\} tabIndex=\{-1\}/);
});
test('keyboard: arrows/Home/End move, Esc returns to the button, Tab closes and continues from the button', () => {
  const src = menuSrc();
  for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) assert.ok(src.includes(`e.key === '${k}'`), k);
  assert.match(src, /e\.key === 'Tab'\) \{ btnRef\.current\?\.focus\(\); flushSync\(\(\) => setOpen\(false\)\); \}/);
});
test('bug reports page links to the reported page by relative path, never another deployment', () => {
  const src = readFileSync(new URL('../../app/bug-reports/page.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('href={r.page_url}'));
  assert.match(src, /href=\{path\.startsWith\('\/'\) && !path\.startsWith\('\/\/'\) \? path : undefined\}/);
});
test('no hardcoded deployment URLs in app code', () => {
  const hits = execSync("grep -rlE 'vercel\\.app|tms-app-git' app || true", { encoding: 'utf8' }).trim();
  assert.equal(hits, '');
});
