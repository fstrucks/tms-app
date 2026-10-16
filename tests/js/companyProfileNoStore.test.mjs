import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noStoreFetch } from '../../app/lib/noStoreFetch.js';

test('noStoreFetch forces cache: no-store and keeps other options', async () => {
  const orig = globalThis.fetch; let seen;
  globalThis.fetch = async (u, init) => { seen = { u, init }; return new Response('[]'); };
  try { await noStoreFetch('http://x/rest/v1/t', { headers: { a: '1' }, cache: 'force-cache' }); } finally { globalThis.fetch = orig; }
  assert.equal(seen.init.cache, 'no-store');
  assert.deepEqual(seen.init.headers, { a: '1' });
});

test('company-profile route never uses the Next data cache', () => {
  const src = readFileSync(new URL('../../app/api/company-profile/route.js', import.meta.url), 'utf8');
  assert.match(src, /fetch: noStoreFetch/);
  assert.match(src, /export const fetchCache = 'force-no-store'/);
  assert.match(src, /'Cache-Control': 'no-store'/);
  const page = readFileSync(new URL('../../app/company/page.js', import.meta.url), 'utf8');
  assert.match(page, /cache: 'no-store'/);
});
