import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteLoad, loadDeletePrompt } from '../../app/lib/loadDelete.js';

function fake({ fail = {}, loadRows = [{ id: 'L1' }] } = {}) {
  const calls = [];
  const res = (key, data) => (fail[key] ? { data: null, error: { message: key + ' boom' } } : { data, error: null });
  const sb = {
    from: (t) => ({
      update: (patch) => ({ eq: async (c, v) => { calls.push(['update', t, patch, v]); return res('update:' + t, null); } }),
      delete: () => ({ eq: (c, v) => {
        const p = { select: async () => { calls.push(['delete', t, v]); return res('delete:' + t, t === 'loads' ? loadRows : [{ id: v }]); } };
        p.then = (ok, ko) => { calls.push(['delete', t, v]); return Promise.resolve(res('delete:' + t, null)).then(ok, ko); };
        return p;
      } }),
    }),
    storage: { from: () => ({ remove: async (p) => { calls.push(['storage', p]); return { error: null }; } }) },
  };
  return { sb, calls };
}
const docs = [{ id: 'd1', file_path: 'u/a.pdf' }];

test('default: unlinks expenses, mileage, documents; deletes stops then load', async () => {
  const { sb, calls } = fake();
  assert.deepEqual(await deleteLoad(sb, 'L1', { docs }), { ok: true, warnings: [] });
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(':')), ['update:expenses', 'update:mileage_entries', 'update:documents', 'delete:stops', 'delete:loads']);
  assert.ok(calls.filter((c) => c[0] === 'update').every((c) => c[2].load_id === null));
  assert.ok(!calls.some((c) => c[0] === 'delete' && ['expenses', 'mileage_entries', 'documents'].includes(c[1])));
});
test('opt-in deletes document rows and files, never expenses/mileage', async () => {
  const { sb, calls } = fake();
  const r = await deleteLoad(sb, 'L1', { docs, deleteDocs: true });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === 'documents'));
  assert.ok(calls.some((c) => c[0] === 'storage'));
  assert.ok(!calls.some((c) => c[0] === 'delete' && ['expenses', 'mileage_entries'].includes(c[1])));
});
test('expense unlink failure stops before anything is deleted', async () => {
  const { sb, calls } = fake({ fail: { 'update:expenses': 1 } });
  const r = await deleteLoad(sb, 'L1', { docs });
  assert.equal(r.ok, false); assert.match(r.error, /expenses/);
  assert.ok(!calls.some((c) => c[0] === 'delete'));
});
test('0 load rows (RLS) is a failure', async () => {
  const { sb } = fake({ loadRows: [] });
  const r = await deleteLoad(sb, 'L1');
  assert.equal(r.ok, false); assert.match(r.error, /not permitted/);
});
test('prompt', () => {
  assert.match(loadDeletePrompt(0), /stops\?$/);
  assert.match(loadDeletePrompt(2, false), /2 documents will be kept/);
  assert.match(loadDeletePrompt(1, true), /1 document\?/);
});
test('retry after partial doc delete: already-deleted doc counts as done', async () => {
  const calls = [];
  const sb = {
    from: (t) => ({
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: (c, v) => { const p = { select: async () => { calls.push([t, v]); return { data: t === 'documents' && v === 'd1' ? [] : [{ id: v }], error: null }; } }; p.then = (ok) => Promise.resolve({ error: null }).then(ok); return p; } }),
    }),
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
  const r = await deleteLoad(sb, 'L1', { docs: [{ id: 'd1', file_path: 'a' }, { id: 'd2', file_path: 'b' }], deleteDocs: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.join(':')), ['documents:d1', 'documents:d2', 'loads:L1']);
});
test('prompt lists kept expenses and mileage', () => {
  assert.equal(loadDeletePrompt(0, false, { expenses: 3, mileage: 2 }), 'Delete this load and its stops? 3 expenses and 2 mileage entries will be kept, unlinked.');
  assert.match(loadDeletePrompt(1, false, { expenses: 1 }), /1 document and 1 expense will be kept/);
});
