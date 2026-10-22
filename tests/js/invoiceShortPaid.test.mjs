// Short-paid invoices keep the load open (Marc, Oct 22): write off the balance or collect the rest to settle.
// Also: the "Finalized as INV-…" message clears after a void. Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { statusChange, balanceDue } from '../../app/lib/invoiceBundle.js';
import * as ACT from '../../app/api/invoices/[id]/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const L1 = '00000000-0000-4000-8000-0000000000b1', I1 = '00000000-0000-4000-8000-0000000000c1';
const inv0 = { id: I1, owner_id: OWNER, load_id: L1, status: 'sent', invoice_number: 'INV-1001', total: 2585, load_ref: { load_number: 'TEST-1001' } };

function ctx(role, userId, invoice, loadStatus = 'invoiced') {
  const svc = fakeSupabase({ tables: { invoices: [{ ...invoice }], invoice_events: [], loads: [{ id: L1, user_id: OWNER, status: loadStatus }] } });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }) };
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const req = (body) => new Request('http://x/api', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = async (c, body) => (await ACT.POST(req(body), { params: { id: I1 }, deps: c.deps })).json();

test('rules: short payment stays open; later payments add up; full balance → Paid', () => {
  const a = statusChange(inv0, 'paid', { paid_amount: '2,500', paid_at: '2026-10-20' });
  assert.equal(a.patch.status, 'short_paid'); assert.equal(a.loadStatus, 'finalize');
  const sp = { ...inv0, status: 'short_paid', paid_amount: 2500 };
  assert.equal(balanceDue(sp), 85);
  const b = statusChange(sp, 'paid', { paid_amount: '50' });
  assert.equal(b.patch.status, 'short_paid'); assert.equal(b.patch.paid_amount, 2550); assert.equal(b.loadStatus, 'finalize');
  const c = statusChange(sp, 'paid', { paid_amount: '' });
  assert.equal(c.patch.status, 'paid'); assert.equal(c.patch.paid_amount, 2585); assert.equal(c.loadStatus, 'paid');
  assert.equal(statusChange(inv0, 'paid', {}).loadStatus, 'paid');
  assert.ok(statusChange(sp, 'paid', { paid_amount: '0' }).error);
  assert.ok(statusChange({ ...inv0, status: 'paid' }, 'paid', {}).error);
});

test('rules: write off only from short-paid; settles as Paid with the balance kept', () => {
  const w = statusChange({ ...inv0, status: 'short_paid', paid_amount: 2500 }, 'write_off', {}, '2026-10-22');
  assert.deepEqual(w.patch, { status: 'paid', written_off_amount: 85, written_off_at: '2026-10-22' });
  assert.equal(w.event.kind, 'written_off'); assert.equal(w.loadStatus, 'paid');
  for (const s of ['ready', 'sent', 'paid']) assert.ok(statusChange({ ...inv0, status: s }, 'write_off', {}).error, s);
});

test('route: short payment does not move the load to Paid (Invoiced stays, Delivered → Invoiced)', async () => {
  const c = ctx('owner', OWNER, inv0);
  const j = await post(c, { action: 'paid', paid_amount: '2500', paid_at: '2026-10-20' });
  assert.equal(j.invoice.status, 'short_paid'); assert.equal(c.svc.db.loads[0].status, 'invoiced'); assert.equal(j.loadStatus, 'invoiced');
  const d = ctx('owner', OWNER, inv0, 'delivered');
  await post(d, { action: 'paid', paid_amount: '100' });
  assert.equal(d.svc.db.loads[0].status, 'invoiced');
});

test('route: write off → invoice Paid, load Paid, event logged', async () => {
  const c = ctx('owner', OWNER, { ...inv0, status: 'short_paid', paid_amount: 2500 });
  const j = await post(c, { action: 'write_off' });
  assert.equal(j.invoice.status, 'paid'); assert.equal(j.invoice.written_off_amount, 85);
  assert.equal(c.svc.db.loads[0].status, 'paid'); assert.equal(j.loadStatusBefore, 'invoiced'); assert.equal(j.loadStatus, 'paid');
  assert.equal(c.svc.db.invoice_events.at(-1).kind, 'written_off');
});

test('route: a later payment covering the balance → load Paid', async () => {
  const c = ctx('owner', OWNER, { ...inv0, status: 'short_paid', paid_amount: 2500 });
  const j = await post(c, { action: 'paid', paid_amount: '85' });
  assert.equal(j.invoice.status, 'paid'); assert.equal(j.invoice.paid_amount, 2585); assert.equal(c.svc.db.loads[0].status, 'paid');
});

test('UI: write-off button, short-paid flag, another-payment form; Finalized message clears on void', () => {
  const b = read('../../app/components/InvoiceBundle.js');
  assert.match(b, /Write off balance/); assert.match(b, /act\('write_off'/); assert.match(b, /short-paid-flag/);
  assert.match(b, /\['ready', 'sent', 'short_paid'\]\.includes\(inv\.status\) && <div[^>]*>\s*<span style=\{s\.muted\}>\{inv\.status === 'short_paid'/);
  const t = read('../../app/components/InvoiceTab.js');
  assert.match(t, /next\?\.status === 'void'\) \{ setMsg\(null\);/);
  assert.ok(!/short_paid'\) cb\.current\.onLoadStatus\?\.\('paid'\)/.test(t));
  const m = read('../../supabase/migrations/20261022120000_invoice_write_off.sql');
  assert.match(m, /written_off_amount/); assert.match(m, /'written_off'/);
});
