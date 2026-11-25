// Report a bug button / bottom controls vs the phone Sharing location bar (Marc, Nov 24: the button covered the bar's Stop).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shareBarOffsetPx, applyShareBarOffset, SHARE_BAR_VAR } from '../../app/lib/shareBarOffset.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('offset is the bar height only while it is fixed (phones); 0 on desktop (sticky) or when hidden', () => {
  assert.equal(shareBarOffsetPx('fixed', 87.2), 88);
  assert.equal(shareBarOffsetPx('sticky', 87), 0);
  assert.equal(shareBarOffsetPx('fixed', 0), 0);
  assert.equal(shareBarOffsetPx('fixed', NaN), 0);
});

test('applyShareBarOffset sets the variable, and clears it at 0 so the button returns to its usual spot', () => {
  const m = new Map();
  const style = { setProperty: (k, v) => m.set(k, v), removeProperty: (k) => m.delete(k) };
  applyShareBarOffset(style, 88); assert.equal(m.get(SHARE_BAR_VAR), '88px');
  applyShareBarOffset(style, 0); assert.equal(m.has(SHARE_BAR_VAR), false);
});

test('Report a bug button sits above the bar, the tab bar and the safe area', () => {
  assert.match(read('app/components/ReportBugButton.js'), /bottom: 'calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\) \+ var\(--share-bar-h, 0px\) \+ 12px\)'/);
  const bar = read('app/components/LocationShareBar.js');
  assert.match(bar, /ref=\{barRef\} className="location-share-bar"/);
  assert.match(bar, /applyShareBarOffset\(root\.style, 0\)/); // cleared when the bar goes away
});

function files(dir, out = []) {
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) files(p, out); else if (/\.(js|css)$/.test(n)) out.push(p);
  }
  return out;
}
test('every control anchored above the tab bar also clears the Sharing location bar', () => {
  const misses = [];
  for (const f of files('app')) {
    if (f.endsWith('AppNav.js')) continue; // the tab bar itself
    read(f).split('\n').forEach((line, i) => {
      if (!/var\(--nav-h(, 0px)?\) \+ env\(safe-area-inset-bottom\)/.test(line)) return;
      if (/--share-bar-h/.test(line)) return;
      if (f.endsWith('globals.css') && (/^\s+bottom: calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\)\);$/.test(line) || /body\.has-appnav \{ padding-bottom/.test(line))) return; // the bar itself; base page padding
      misses.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(misses, []);
});
