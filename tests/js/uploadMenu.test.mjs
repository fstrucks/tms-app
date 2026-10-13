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

test('UploadMenu: menu closes only after the input receives its click (Android: click after touchend)', () => {
  const arm = src.slice(src.indexOf('const arm = '), src.indexOf('const onItemKey'));
  assert.ok(arm.length > 0);
  // setOpen only inside the deferred onBack / cancel listeners, never directly on the tap path.
  const direct = arm.split('\n').filter((l) => /setOpen|setTimeout/.test(l) && !/onBack = |'cancel'/.test(l));
  assert.deepEqual(direct, [], 'option tap must not close/unmount the menu');
  assert.match(src, /onClick=\{closeAfterInputClick\}/);
  assert.match(src, /const closeAfterInputClick = \(\) => setTimeout\(\(\) => setOpen\(false\), 0\)/);
  // The only .click() is the keyboard path, called synchronously in the key handler.
  assert.equal((src.match(/\.click\(\)/g) || []).length, 1);
  assert.match(src, /arm\(id\)\?\.click\(\)/);
});

test('UploadMenu: focusout ignores relatedTarget=null (iOS tap)', () => {
  assert.match(src, /open && e\.relatedTarget && wrapRef\.current/);
});

test('UploadMenu: no preventDefault on pointer/touch paths, no pointer-events:none / zero-size input', () => {
  assert.doesNotMatch(src, /on(Pointer|Touch|Mouse)(Down|Start)/);
  assert.equal((src.match(/preventDefault\(\)/g) || []).length, 5, 'only the keyboard handlers call preventDefault');
  assert.doesNotMatch(src, /pointerEvents:\s*'none'/);
  assert.match(src, /VISUALLY_HIDDEN = \{[^}]*width: 1, height: 1/);
});

test('UploadMenu: change, cancel and window focus also close the menu', () => {
  assert.match(src, /onChange=\{\(e\) => \{ setOpen\(false\)/);
  assert.match(src, /'cancel', \(\) => \{ clearBack\(\); setOpen\(false\)/);
  assert.match(src, /const onBack = \(\) => \{ backRef\.current = null; setOpen\(false\)/);
});
