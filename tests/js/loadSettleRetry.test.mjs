import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFreshLoad, FRESH_LOAD_MS } from '../../app/lib/loadSeed.js';

test('isFreshLoad: only loads created in the last 2 minutes', () => {
  const now = Date.parse('2026-10-22T15:00:00Z');
  assert.equal(isFreshLoad({ created_at: '2026-10-22T14:59:50Z' }, now), true);
  assert.equal(isFreshLoad({ created_at: new Date(now - FRESH_LOAD_MS - 1).toISOString() }, now), false);
  assert.equal(isFreshLoad({}, now), false);
  assert.equal(isFreshLoad(null, now), false);
});

test('load page re-reads once after Create load and refreshes the cards', () => {
  const page = readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8');
  assert.match(page, /if \(!settleTried\.current\) \{ settleTried\.current = true; return setTimeout/);
  assert.match(page, /useLoadFacilities\(load\?\.id, `\$\{load\?\.stops\?\.length \?\? ''\}:\$\{settleVer\}`\)/);
  assert.match(page, /refreshKey=\{settleVer\}/);
  assert.match(page, /recheck=\{routeCheck \+ settleVer\}/);
});
