import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const list = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('loads STATUSES exactly match the loads_status_check migration', () => {
  const js = read('app/lib/loads.js').match(/export const STATUSES\s*=\s*\[([^\]]*)\]/);
  assert.ok(js, 'STATUSES not found in app/lib/loads.js');
  const sql = read('supabase/migrations/20261013001000_loads_status_check.sql')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .match(/check\s*\(\s*status\s+in\s*\(([^)]*)\)/i);
  assert.ok(sql, 'check (status in (...)) not found in migration');
  assert.deepEqual(list(js[1]), list(sql[1]));
});
