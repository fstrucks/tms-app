// Deleting a load removes its unfinalized draft invoice; orphan drafts can be deleted from the Invoices list.
// Fake data only (Test Trucking Co).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { deleteLoad } from '../../app/lib/loadDelete.js';
import { isOrphanDraft } from '../../app/lib/invoice.js';
import * as INV from '../../app/api/invoices/[id]/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const I = (n) => `00000000-0000-4000-8000-00000000c00${n}`;
const inv = (n, over = {}) => ({ id: I(n), owner_id: OWNER, load_id: L1, status: 'draft', invoice_number: null, total: 1000, ...over });

function world(invoices) {
  const sb = fakeSupabase({ tables: { invoices, loads: [{ id: L1, user_id: OWNER }], stops: [], expenses: [], mileage_entries: [], documents: [], invoice_events: [] } });
  sb.rpc = async () => ({ data: null, error: null });
  return sb;
}

test('load delete removes its unfinalized draft invoice(s) and the load', async () => {
  const sb = world([inv(1), inv(2, { auto_drafted: true })]);
  const r = await deleteLoad(sb, L1);
  assert.equal(r.ok, true);
  assert.equal(sb.db.invoices.length, 0);
  assert.equal(sb.db.loads.length, 0);
});

test('load delete never touches finalized / sent / paid invoices: it is blocked with the existing message and nothing is deleted', async () => {
  for (const status of ['ready', 'sent', 'paid', 'short_paid']) {
    const sb = world([inv(1), inv(2, { status, invoice_number: 'INV-1001' })]);
    const r = await deleteLoad(sb, L1);
    assert.equal(r.ok, false, status);
    assert.match(r.error, /Void it first/);
    assert.equal(sb.db.invoices.length, 2, status); // the draft stays too: nothing changed
    assert.equal(sb.db.loads.length, 1);
  }
});

test('void invoices are kept (unlinked by the database), only the draft goes', async () => {
  const sb = world([inv(1), inv(2, { status: 'void', invoice_number: 'INV-1002' })]);
  const r = await deleteLoad(sb, L1);
  assert.equal(r.ok, true);
  assert.deepEqual(sb.db.invoices.map((x) => x.id), [I(2)]);
});

test('orphan draft rule: only an unnumbered draft with no load', () => {
  assert.equal(isOrphanDraft(inv(1, { load_id: null })), true);
  assert.equal(isOrphanDraft(inv(1)), false); // has a load: open it from the row
  assert.equal(isOrphanDraft(inv(1, { load_id: null, status: 'void', invoice_number: 'INV-9' })), false);
  assert.equal(isOrphanDraft(inv(1, { load_id: null, status: 'sent', invoice_number: 'INV-9' })), false);
  assert.equal(isOrphanDraft(null), false);
});

function ctx(role, userId, invoices) {
  const svc = fakeSupabase({ tables: { invoices, invoice_events: [], loads: [] } });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }) };
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const del = (c, id) => INV.DELETE(new Request('http://x/api', { method: 'DELETE', headers: { authorization: 'Bearer t' } }), { params: { id }, deps: c.deps });

test('DELETE /api/invoices/:id deletes an orphan draft; refuses finalized, sent, paid and void; other company is 404', async () => {
  const c = ctx('owner', OWNER, [inv(1, { load_id: null }), inv(2, { load_id: null, status: 'sent', invoice_number: 'INV-1' }), inv(3, { load_id: null, status: 'void', invoice_number: 'INV-2' }),
    inv(4, { load_id: null, owner_id: '00000000-0000-4000-8000-0000000000ee' })]);
  assert.equal((await del(c, I(1))).status, 200);
  assert.equal(c.svc.db.invoices.some((x) => x.id === I(1)), false);
  for (const n of [2, 3]) { assert.equal((await del(c, I(n))).status, 409); assert.equal(c.svc.db.invoices.some((x) => x.id === I(n)), true); }
  assert.equal((await del(c, I(4))).status, 404);
  assert.equal((await del(c, 'nope')).status, 404);
});

test('DELETE is for roles that can edit invoices; a driver is refused', async () => {
  const c = ctx('driver', '00000000-0000-4000-8000-0000000000d1', [inv(1, { load_id: null })]);
  assert.equal((await del(c, I(1))).status, 403);
  assert.equal(c.svc.db.invoices.length, 1);
});

test('Invoices page: orphan drafts get a Delete draft button; rows with a load still link to it', () => {
  const p = read('app/invoices/page.js');
  assert.match(p, /isOrphanDraft\(i\)/);
  assert.match(p, /invoice-delete-orphan/);
  assert.match(p, /method: 'DELETE'/);
  assert.match(p, /\/loads\/\$\{i\.load_id\}\?tab=invoice/);
});

import { orphanDeleteOutcome } from '../../app/lib/invoice.js';
test('orphan delete outcome: success and 404 remove the row with no alert; other errors keep it and show the message', () => {
  assert.deepEqual(orphanDeleteOutcome({ ok: true }), { remove: true, error: null });
  assert.deepEqual(orphanDeleteOutcome({ error: 'Invoice not found.', status: 404 }), { remove: true, error: null });
  assert.deepEqual(orphanDeleteOutcome({ error: 'Couldn’t delete the draft.', status: 500 }), { remove: false, error: 'Couldn’t delete the draft.' });
  assert.equal(orphanDeleteOutcome({ error: 'x', status: 409 }).remove, false);
});
test('Invoices page removes the row immediately, then refetches', () => {
  const p = read('app/invoices/page.js');
  assert.match(p, /orphanDeleteOutcome\(j\)/);
  assert.match(p, /filter\(\(x\) => x\.id !== i\.id\)/);
  assert.ok(p.indexOf('filter((x) => x.id !== i.id)') < p.indexOf("api('/api/invoices').then((r) => setSt(r.error"));
});
