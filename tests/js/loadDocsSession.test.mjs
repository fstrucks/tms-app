import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLoadDocs, fetchTeamDocs } from '../../app/lib/loadDocsClient.js';

function sb() {
  return { auth: {
    getSession: async () => ({ data: { session: { access_token: 'stale' } } }),
    refreshSession: async () => ({ data: { session: { access_token: 'fresh' } } }),
  }, from() { throw new Error('should not fall back'); } };
}
const fetchImpl = async (url, o) => {
  const ok = o.headers.Authorization === 'Bearer fresh';
  return { ok, status: ok ? 200 : 401, json: async () => (ok ? { documents: [{ id: 'd1' }] } : { error: 'Your sign-in expired.' }) };
};

test('load docs refresh a stale token once and retry', async () => {
  const r = await fetchLoadDocs(sb(), 'L1', { fetchImpl });
  assert.deepEqual(r, { data: [{ id: 'd1' }], error: null });
});
test('team docs refresh a stale token once and retry', async () => {
  const r = await fetchTeamDocs(sb(), { fetchImpl });
  assert.deepEqual(r, { data: [{ id: 'd1' }], error: null });
});
