import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteLoad, loadDeletePrompt } from '../../app/lib/loadDelete.js';

function fake({ fail = {}, loadRows = [{ id: 'L1' }], invoices = [] } = {}) {
  const calls = [];
  const res = (key, data) => (fail[key] ? { data: null, error: { message: key + ' boom' } } : { data, error: null });
  const sb = {
    from: (t) => ({
      select: () => ({ eq: async () => ({ data: t === 'invoices' ? invoices : [], error: null }) }),
      update: (patch) => ({ eq: async (c, v) => { calls.push(['update', t, patch, v]); return res('update:' + t, null); } }),
      delete: () => ({ eq: (c, v) => {
        const p = { select: async () => { calls.push(['delete', t, v]); return res('delete:' + t, t === 'loads' ? loadRows : [{ id: v }]); } };
        p.then = (ok, ko) => { calls.push(['delete', t, v]); return Promise.resolve(res('delete:' + t, null)).then(ok, ko); };
        return p;
      } }),
    }),
    storage: { from: () => ({ remove: async (p) => { calls.push(['storage', p]); return { error: null }; } }) },
    rpc: async (fn, args) => { calls.push(['rpc', fn, args]); return { data: 0, error: null }; },
  };
  return { sb, calls };
}
const docs = [{ id: 'd1', file_path: 'u/a.pdf' }];

test('default: unlinks expenses, mileage, documents; deletes stops then load', async () => {
  const { sb, calls } = fake();
  assert.deepEqual(await deleteLoad(sb, 'L1', { docs }), { ok: true, warnings: [] });
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(':')), ['rpc:mark_load_email_ratecons_handled', 'update:expenses', 'update:mileage_entries', 'update:documents', 'delete:stops', 'delete:loads']);
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
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: (c, v) => { const p = { select: async () => { calls.push([t, v]); return { data: t === 'documents' && v === 'd1' ? [] : [{ id: v }], error: null }; } }; p.then = (ok) => Promise.resolve({ error: null }).then(ok); return p; } }),
    }),
    rpc: async () => ({ data: 0, error: null }),
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

test('a non-void finalized invoice blocks the delete before anything is touched', async () => {
  const { sb, calls } = fake({ invoices: [{ id: 'i1', status: 'paid', invoice_number: 'INV-1001' }] });
  const r = await deleteLoad(sb, 'L1', { docs });
  assert.equal(r.ok, false); assert.match(r.error, /INV-1001.*Void it first/);
  assert.equal(calls.length, 0);
});
test('void and draft invoices do not block the delete', async () => {
  const { sb, calls } = fake({ invoices: [{ id: 'i1', status: 'void', invoice_number: 'INV-1001' }, { id: 'i2', status: 'draft', invoice_number: null }] });
  assert.equal((await deleteLoad(sb, 'L1', { docs })).ok, true);
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === 'loads'));
});
test('migration lets only a void invoice be unlinked from its load', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../supabase/migrations/20261022200000_invoice_void_unlink_load.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.invoices_guard\(\)/);
  assert.match(sql, /not \(old\.status = 'void' and new\.load_id is null\)/);
  assert.doesNotMatch(sql, /\b(update|delete from|insert into)\s+public\./i);
});

test('delete confirm matches the Also delete box (company docs are unlinked, not deleted)', async () => {
  const { loadDeleteDocsLabel } = await import('../../app/lib/loadDelete.js');
  assert.equal(loadDeleteDocsLabel(3, 1, 1), 'Also delete your 2 linked documents; 1 team document and 1 company document will be unlinked, not deleted');
  assert.equal(loadDeletePrompt(3, true, {}, 1, 1), 'Delete this load, its stops and your 2 documents? 1 team document and 1 company document will be kept, unlinked.');
  assert.equal(loadDeleteDocsLabel(2, 0, 0), 'Also delete 2 linked documents');
  assert.equal(loadDeletePrompt(2, true), 'Delete this load, its stops and 2 documents?');
  assert.equal(loadDeleteDocsLabel(1, 0, 1), null);
  assert.equal(loadDeletePrompt(1, false, {}, 0, 1), 'Delete this load and its stops? 1 document will be kept, unlinked.');
  // Truck-tab scale ticket photos are not in the delete count. Say they stay.
  assert.equal(loadDeleteDocsLabel(1, 0, 0, 1), 'Also delete 1 linked document. Scale ticket photos stay in your Truck tab.');
  assert.equal(loadDeletePrompt(1, true, {}, 0, 0, 1), 'Delete this load, its stops and 1 document? Scale ticket photos stay in your Truck tab.');
  assert.equal(loadDeletePrompt(1, false, {}, 0, 0, 1), 'Delete this load and its stops? 1 document will be kept, unlinked. Scale ticket photos stay in your Truck tab.');
  assert.equal(loadDeletePrompt(0, false, {}, 0, 0, 1), 'Delete this load and its stops? Scale ticket photos stay in your Truck tab.');
});
