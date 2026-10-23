import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countByTab } from '../../app/lib/loadTabs.js';

test('removing the deleted load clears its Pending count', () => {
  const loads = [{ id: 'a', status: 'delivered' }, { id: 'b', status: 'booked' }];
  assert.equal(countByTab(loads).pending, 1);
  assert.equal(countByTab(loads.filter((l) => l.id !== 'a')).pending || 0, 0);
});

test('load page drops the deleted load from the shared list before re-fetching', () => {
  const data = readFileSync(new URL('../../app/loads/LoadsData.js', import.meta.url), 'utf8');
  assert.match(data, /const dropLoad = \(id\) => \{ reqRef\.current\+\+; setLoads\(\(ls\) => ls\.filter\(\(l\) => l\.id !== id\)\); return loadLoads\(\); \};/);
  assert.match(data, /patchLoad, dropLoad \}/);
  const page = readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8');
  assert.match(page, /if \(list\?\.dropLoad\) list\.dropLoad\(id\);/);
});
