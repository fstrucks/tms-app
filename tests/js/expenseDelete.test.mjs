import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './fakeSupabase.mjs';
import { deleteExpense } from '../../app/lib/expenseDelete.js';

function client(tables) {
  const sb = fakeSupabase({ tables });
  const removed = [];
  sb.storage = { from: () => ({ remove: async (paths) => { removed.push(...paths); return { error: null }; } }) };
  return { sb, removed };
}

test('deleting the only expense of a receipt deletes the receipt row and file', async () => {
  const { sb, removed } = client({ expenses: [{ id: 'e1', document_id: 'r1' }], documents: [{ id: 'r1', doc_type: 'receipt', file_path: 'u/r1.jpg' }] });
  assert.deepEqual(await deleteExpense(sb, { id: 'e1', document_id: 'r1' }), { ok: true });
  assert.equal((await sb.from('documents').select('id').eq('id', 'r1')).data.length, 0);
  assert.deepEqual(removed, ['u/r1.jpg']);
});

test('receipt shared with another expense is kept', async () => {
  const { sb, removed } = client({ expenses: [{ id: 'e1', document_id: 'r1' }, { id: 'e2', document_id: 'r1' }], documents: [{ id: 'r1', doc_type: 'receipt', file_path: 'u/r1.jpg' }] });
  assert.equal((await deleteExpense(sb, { id: 'e1', document_id: 'r1' })).ok, true);
  assert.equal((await sb.from('documents').select('id').eq('id', 'r1')).data.length, 1);
  assert.deepEqual(removed, []);
});

test('a non-receipt document is never deleted; no document → just the expense', async () => {
  const { sb, removed } = client({ expenses: [{ id: 'e1', document_id: 'b1' }, { id: 'e3' }], documents: [{ id: 'b1', doc_type: 'bol', file_path: 'u/b1.pdf' }] });
  await deleteExpense(sb, { id: 'e1', document_id: 'b1' });
  assert.equal((await sb.from('documents').select('id').eq('id', 'b1')).data.length, 1);
  assert.deepEqual(await deleteExpense(sb, { id: 'e3' }), { ok: true });
  assert.equal((await sb.from('expenses').select('id')).data.length, 0);
  assert.deepEqual(removed, []);
});
