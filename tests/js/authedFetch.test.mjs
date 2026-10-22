// Rate con / receipt extraction: stale access token is refreshed once instead of "Please sign in again."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authedFetch, isAuthOutage } from '../../app/lib/authedFetch.js';

const mkAuth = (token, fresh) => { const a = { refreshes: 0, getSession: async () => ({ data: { session: token ? { access_token: token } : null } }), refreshSession: async () => { a.refreshes++; return { data: { session: fresh ? { access_token: fresh } : null } }; } }; return a; };
const mkFetch = (good) => { const seen = []; const f = async (_u, o) => { const t = o.headers.Authorization.replace('Bearer ', ''); seen.push(t); return { status: t === good ? 200 : 401 }; }; f.seen = seen; return f; };

test('stale token: refresh once and retry with the new one', async () => {
  const auth = mkAuth('old', 'new'); const f = mkFetch('new');
  const r = await authedFetch(auth, '/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, { fetchImpl: f });
  assert.equal(r.status, 200); assert.deepEqual(f.seen, ['old', 'new']); assert.equal(auth.refreshes, 1);
});
test('valid token: no refresh; missing session: refresh first', async () => {
  let auth = mkAuth('ok', 'x'); let f = mkFetch('ok');
  assert.equal((await authedFetch(auth, '/u', {}, { fetchImpl: f })).status, 200); assert.equal(auth.refreshes, 0);
  auth = mkAuth(null, 'ok'); f = mkFetch('ok');
  assert.equal((await authedFetch(auth, '/u', {}, { fetchImpl: f })).status, 200); assert.deepEqual(f.seen, ['ok']);
});
test('really signed out: 401 is returned after one refresh attempt (no loop)', async () => {
  const auth = mkAuth('old', null); const f = mkFetch('never');
  assert.equal((await authedFetch(auth, '/u', {}, { fetchImpl: f })).status, 401); assert.deepEqual(f.seen, ['old']);
});
test('server: auth outage is not a sign-out', () => {
  assert.ok(isAuthOutage({ name: 'AuthRetryableFetchError', status: 0 })); assert.ok(isAuthOutage({ status: 503 }));
  assert.ok(!isAuthOutage({ name: 'AuthApiError', status: 401 })); assert.ok(!isAuthOutage(null));
  for (const p of ['../../app/api/extract/route.js', '../../app/api/extract-receipt/route.js']) assert.match(readFileSync(new URL(p, import.meta.url), 'utf8'), /isAuthOutage\(userErr\)\) return fail\(503/);
  for (const p of ['../../app/documents/page.js', '../../app/expenses/page.js']) assert.match(readFileSync(new URL(p, import.meta.url), 'utf8'), /authedFetch\(supabase\.auth, '\/api\/extract/);
});

import { stopZone, stateTz } from '../../app/lib/stopTimesPdf.js';
test('stop times PDF zone: stop tz, then state, then viewer, then Central', () => {
  assert.equal(stopZone({ timezone: 'America/Denver', state: 'CA' }, 'America/Los_Angeles'), 'America/Denver');
  assert.equal(stopZone({ timezone: null, state: 'co' }, 'America/Los_Angeles'), 'America/Denver');
  assert.equal(stopZone({ timezone: 'Bad/Zone', state: '' }, 'America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(stopZone({}, null), 'America/Chicago');
  assert.equal(stateTz('TX'), 'America/Chicago'); assert.equal(stateTz('AZ'), 'America/Phoenix'); assert.equal(stateTz('ZZ'), null);
});
