import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteDocument, deletePrompt } from '../../app/lib/documents.js';

function fake({ rows = [{ id: 'd1' }], dbErr = null, sErr = null } = {}) {
  const calls = [];
  const sb = {
    from: (t) => ({ delete: () => ({ eq: (c, v) => ({ select: async () => { calls.push(['db', t, v]); return { data: dbErr ? null : rows, error: dbErr }; } }) }) }),
    storage: { from: (b) => ({ remove: async (p) => { calls.push(['storage', b, p]); return { error: sErr }; } }) },
  };
  return { sb, calls };
}
const doc = { id: 'd1', file_path: 'u1/x.pdf' };

test('deletes row then storage file', async () => {
  const { sb, calls } = fake();
  assert.deepEqual(await deleteDocument(sb, doc), { ok: true });
  assert.deepEqual(calls, [['db', 'documents', 'd1'], ['storage', 'documents', ['u1/x.pdf']]]);
});
test('db error stops before storage', async () => {
  const { sb, calls } = fake({ dbErr: { message: 'boom' } });
  const r = await deleteDocument(sb, doc);
  assert.equal(r.ok, false); assert.match(r.error, /boom/); assert.equal(calls.length, 1);
});
test('zero rows (RLS) is a failure', async () => {
  const { sb, calls } = fake({ rows: [] });
  const r = await deleteDocument(sb, doc);
  assert.equal(r.ok, false); assert.equal(calls.length, 1);
});
test('storage error reported', async () => {
  const { sb } = fake({ sErr: { message: 'nope' } });
  const r = await deleteDocument(sb, doc);
  assert.equal(r.ok, true); assert.match(r.fileError, /nope/);
});
test('prompt warns when linked to a load', () => {
  assert.match(deletePrompt({ load_id: 'l1' }), /load is kept/);
  assert.doesNotMatch(deletePrompt({}), /load/);
});
test('missingOk treats 0 rows as done (default still fails)', async () => {
  const { sb } = fake({ rows: [] });
  assert.deepEqual(await deleteDocument(sb, doc, 'documents', { missingOk: true }), { ok: true });
});
