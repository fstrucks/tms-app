import test from 'node:test'; import assert from 'node:assert'; import fs from 'node:fs';
const m = fs.readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
test('signature options sheet sits above bottom nav (z 50) and sticky bar (z 45)', () => {
  const sec = m.match(/aria-label="Signature options"[^\n]*/)[0];
  assert.match(sec, /position: 'fixed'/); const z = Number(sec.match(/zIndex: (\d+)/)[1]); assert.ok(z > 50);
  assert.match(sec, /safe-area-inset-bottom/);
});
test('page padding tracks the sticky bar height + nav + safe area', () => {
  assert.match(m, /ResizeObserver/); assert.match(m, /barH \+ 16\)\}px \+ var\(--nav-h/);
});
