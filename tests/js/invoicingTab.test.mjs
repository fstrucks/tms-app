// Invoicing PR 2: Invoice tab (draft, extras, factoring switch, finalize) and the invoice PDF. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fakeSupabase } from './fakeSupabase.mjs';
import { cleanLines, draftFields, isFactored, termsFor, brokerForLoad, dueDate, loadRefFrom, invoiceFileName, totalOf, remitToFor, EXTRA_TYPES } from '../../app/lib/invoice.js';
import { invoicePdf, plain } from '../../app/lib/invoicePdf.js';
import * as INV from '../../app/api/loads/[id]/invoice/route.js';
import * as PDF from '../../app/api/invoices/[id]/pdf/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', MGMT = '00000000-0000-4000-8000-0000000000a4', DISP = '00000000-0000-4000-8000-0000000000a5', DRIVER = '00000000-0000-4000-8000-0000000000a2';
const L1 = '00000000-0000-4000-8000-0000000000b1', L2 = '00000000-0000-4000-8000-0000000000b2';
const B1 = '00000000-0000-4000-8000-0000000000d1', F1 = '00000000-0000-4000-8000-0000000000e1';
const company = { id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC', address_line1: '1 Test St', city: 'Example City', state: 'TX', postal_code: '00000', mc_number: '000000', dot_number: '0000000', invoice_prefix: 'INV-', invoice_next_number: 1001, default_terms_days: 30, default_factor_id: null };
const broker = { id: B1, owner_id: OWNER, name: 'Acme Freight Brokerage (fake)', billing_emails: ['ap@example.com'], terms_days: 15, mc_number: '111111' };
const factor = { id: F1, owner_id: OWNER, name: 'Sample Factor Co', remit_to: 'PO Box 0000, Example City' };

test('extras: the six billable extras, in order', () => {
  assert.deepEqual(EXTRA_TYPES.map((t) => t.id), ['lumper', 'detention', 'layover', 'tonu', 'extra_stop', 'scale']);
});

test('cleanLines: types, amounts, decimals', () => {
  assert.deepEqual(cleanLines([{ type: 'linehaul', amount: '$2,400.00' }, { type: 'lumper', amount: 185, note: ' receipt #1 ' }]).lines,
    [{ type: 'linehaul', label: 'Linehaul', amount: 2400, note: null }, { type: 'lumper', label: 'Lumper reimbursement', amount: 185, note: 'receipt #1' }]);
  assert.ok(cleanLines([{ type: 'fuel', amount: 1 }]).error);
  assert.ok(cleanLines([{ type: 'detention', amount: '' }]).error);
  assert.ok(cleanLines([{ type: 'detention', amount: '10.005' }]).error);
  assert.ok(cleanLines('x').error);
  assert.equal(totalOf([{ amount: 0.1 }, { amount: 0.2 }]), 0.3);
});

test('factoring switch + terms + broker match', () => {
  assert.equal(isFactored({ factored: null }, { default_factor_id: F1 }), true);
  assert.equal(isFactored({ factored: false }, { default_factor_id: F1 }), false);
  assert.equal(isFactored({}, {}), false);
  assert.equal(termsFor(broker, company), 15);
  assert.equal(termsFor({ terms_days: null }, company), 30);
  assert.equal(termsFor(null, null), 30);
  assert.equal(brokerForLoad({ broker_name: ' acme freight brokerage (FAKE)' }, [broker]).id, B1);
  assert.equal(brokerForLoad({ broker_id: B1, broker_name: 'other' }, [broker]).id, B1);
  assert.equal(brokerForLoad({ broker_name: 'nope' }, [broker]), null);
  assert.equal(dueDate('2026-10-21', 30), '2026-11-20');
  assert.equal(remitToFor({ factored: true, factor, company }), 'Sample Factor Co\nPO Box 0000, Example City');
  assert.match(remitToFor({ factored: false, factor, company }), /^FAKE Trucking LLC\n1 Test St/);
});

test('draftFields: linehaul from the rate; keeps edited lines; factored → factor remit-to', () => {
  const load = { rate: 2400, broker_load_number: 'TEST-1001', factored: true, stops: [{ sequence: 2, stop_type: 'delivery', city: 'B Town', state: 'OK', completed_at: '2026-10-21T15:00:00Z' }, { sequence: 1, stop_type: 'pickup', company_name: 'Fake Shipper', city: 'A Town', state: 'TX', pickup_number: 'PU-1', appointment_start: '2026-10-20T14:00:00Z' }] };
  const d = draftFields({ load, broker, factor, company });
  assert.deepEqual(d.line_items, [{ type: 'linehaul', label: 'Linehaul', amount: 2400, note: null }]);
  assert.equal(d.total, 2400);
  assert.equal(d.factored, true);
  assert.equal(d.factor_id, F1);
  assert.equal(d.terms_days, 15);
  assert.deepEqual(d.bill_to.emails, ['ap@example.com']);
  assert.deepEqual(loadRefFrom(load).lane.map((s) => [s.type, s.date]), [['pickup', '2026-10-20'], ['delivery', '2026-10-21']]);
  assert.deepEqual(loadRefFrom(load).pickup_numbers, ['PU-1']);
  const kept = draftFields({ load, broker, factor, company, existing: { line_items: [{ type: 'linehaul', amount: 2300 }, { type: 'detention', amount: 100 }] } });
  assert.equal(kept.total, 2400);
  assert.equal(draftFields({ load: { rate: null }, company }).line_items.length, 0);
});

test('file names: {LOAD}_{Doc}.pdf with safe characters', () => {
  assert.equal(invoiceFileName({ load_ref: { load_number: 'TEST 1001/A' } }), 'TEST-1001-A_Invoice.pdf');
  assert.equal(invoiceFileName({ load_ref: {}, invoice_number: 'INV-1001' }, 'pod', 2), 'INV-1001_POD-2.pdf');
});

test('PDF: one page, title has the number, odd characters don’t break it', async () => {
  const inv = { invoice_number: 'INV-1001', status: 'ready', invoice_date: '2026-10-21', due_date: '2026-11-20', terms_days: 30, factored: true, remit_to: 'Sample Factor Co\nPO Box 0000',
    bill_to: { name: 'Acme Freight Brokerage (fake) — “AP”', emails: ['ap@example.com'] }, load_ref: { load_number: 'TEST-1001', lane: [{ type: 'pickup', name: 'Fake Shipper', place: 'A Town, TX', date: '2026-10-20' }] },
    line_items: [{ label: 'Linehaul', amount: 2400 }, { label: 'Lumper reimbursement', amount: 185, note: 'Receipt ✓ 123' }], total: 2585, notes: 'Thanks · fake' };
  const bytes = await invoicePdf(inv, company);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'Invoice INV-1001');
  assert.equal(plain('a’b—c✓'), "a'b-c");
});

// ---- routes ----
function ctx(role, userId, { loads, invoices = [], profile = company } = {}) {
  const tables = {
    company_profiles: [{ ...profile }], brokers: [{ ...broker }], factors: [{ ...factor }], invoices, invoice_events: [],
    loads: loads || [{ id: L1, user_id: OWNER, status: 'delivered', rate: 2400, broker_name: 'Acme Freight Brokerage (fake)', broker_load_number: 'TEST-1001', factored: null, broker_id: null },
      { id: L2, user_id: OWNER, status: 'in_transit', rate: 1950, broker_load_number: 'TEST-4701' }],
  };
  const svc = fakeSupabase({ tables });
  svc.storage.from = () => ({ download: async () => ({ data: null }) });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    rpc: async (fn, a) => {
      if (fn === 'packet_role') return { data: role, error: null };
      if (fn === 'finalize_invoice') { // mirrors the SQL function's main path
        if (!['owner', 'management'].includes(role)) return { data: null, error: { code: 'P0001', message: 'not_allowed' } };
        const inv = svc.db.invoices.find((i) => i.id === a.p_invoice); const p = svc.db.company_profiles[0];
        if (inv.status !== 'draft') return { data: null, error: { code: 'P0001', message: 'not_draft' } };
        if (!(inv.total > 0)) return { data: null, error: { code: 'P0001', message: 'no_lines' } };
        Object.assign(inv, { status: 'ready', invoice_number: `INV-${p.invoice_next_number}`, invoice_seq: p.invoice_next_number, invoice_date: '2026-10-21', due_date: '2026-11-20' });
        p.invoice_next_number += 1;
        const l = svc.db.loads.find((x) => x.id === inv.load_id); if (l?.status === 'delivered') l.status = 'invoiced';
        return { data: { ...inv }, error: null };
      }
      return { data: null, error: null };
    } };
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const req = (method, body) => new Request('http://x/api', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('GET: owner opening a delivered load gets an automatic draft matched to the saved broker', async () => {
  const c = ctx('owner', OWNER);
  const j = await (await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(j.invoice.status, 'draft');
  assert.equal(j.invoice.total, 2400);
  assert.equal(j.invoice.broker_id, B1);
  assert.equal(j.invoice.terms_days, 15);
  assert.equal(j.matchedBrokerId, B1);
  assert.equal(c.svc.db.invoice_events[0].kind, 'drafted');
  assert.equal(c.svc.db.invoices[0].created_by, OWNER, 'created_by = the signed-in user (insert policy)');
  await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps });
  assert.equal(c.svc.db.invoices.length, 1, 'no second draft');
});

test('GET: in-transit load → no draft; dispatcher read-only (no draft made); driver 403; other company 404', async () => {
  const c = ctx('owner', OWNER);
  assert.equal((await (await INV.GET(req('GET'), { params: { id: L2 }, deps: c.deps })).json()).invoice, null);
  const d = ctx('dispatcher', DISP);
  const j = await (await INV.GET(req('GET'), { params: { id: L1 }, deps: d.deps })).json();
  assert.equal(j.canEdit, false); assert.equal(j.invoice, null); assert.equal(d.svc.db.invoices.length, 0);
  assert.equal((await INV.GET(req('GET'), { params: { id: L1 }, deps: ctx('driver', DRIVER).deps })).status, 403);
  assert.equal((await INV.GET(req('GET'), { params: { id: '00000000-0000-4000-8000-0000000000ff' }, deps: c.deps })).status, 404);
});

test('PATCH: management adds extras, sets terms and turns factoring on (saved on the load)', async () => {
  const c = ctx('management', MGMT, { profile: { ...company, default_factor_id: F1 } });
  await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps });
  const r = await INV.PATCH(req('PATCH', { line_items: [{ type: 'linehaul', amount: '2400' }, { type: 'detention', amount: '100', note: '2 hrs' }, { type: 'lumper', amount: '185.50' }], terms_days: '45', factored: true, notes: 'Fake note' }), { params: { id: L1 }, deps: c.deps });
  assert.equal(r.status, 200);
  const inv = c.svc.db.invoices[0];
  assert.equal(inv.total, 2685.5);
  assert.equal(inv.terms_days, 45);
  assert.equal(inv.factored, true);
  assert.equal(inv.factor_id, F1);
  assert.match(inv.remit_to, /^Sample Factor Co/);
  assert.equal(c.svc.db.loads[0].factored, true);
  assert.equal((await INV.PATCH(req('PATCH', { line_items: [{ type: 'fuel', amount: 1 }] }), { params: { id: L1 }, deps: c.deps })).status, 422);
  assert.equal((await INV.PATCH(req('PATCH', { notes: 'x' }), { params: { id: L1 }, deps: ctx('dispatcher', DISP).deps })).status, 403);
});

test('PATCH: factoring on without a factoring company set → 422', async () => {
  const c = ctx('owner', OWNER);
  assert.equal((await INV.PATCH(req('PATCH', { factored: true }), { params: { id: L1 }, deps: c.deps })).status, 422);
});

test('finalize: INV-1001 then INV-1002, load → invoiced, locked after', async () => {
  const c = ctx('owner', OWNER, { loads: [{ id: L1, user_id: OWNER, status: 'delivered', rate: 2400, broker_load_number: 'TEST-1001' }, { id: L2, user_id: OWNER, status: 'delivered', rate: 1950, broker_load_number: 'TEST-4701' }] });
  await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps });
  const j = await (await INV.POST(req('POST', { action: 'finalize' }), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(j.invoice.invoice_number, 'INV-1001');
  assert.equal(j.load.status, 'invoiced');
  await INV.GET(req('GET'), { params: { id: L2 }, deps: c.deps });
  assert.equal((await (await INV.POST(req('POST', { action: 'finalize' }), { params: { id: L2 }, deps: c.deps })).json()).invoice.invoice_number, 'INV-1002');
  assert.equal((await INV.POST(req('POST', { action: 'finalize' }), { params: { id: L1 }, deps: c.deps })).status, 409);
  assert.equal((await INV.PATCH(req('PATCH', { line_items: [{ type: 'linehaul', amount: 1 }] }), { params: { id: L1 }, deps: c.deps })).status, 409);
});

test('PDF route: office roles get application/pdf; driver 403', async () => {
  const c = ctx('owner', OWNER);
  const { invoice } = await (await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps })).json();
  const r = await PDF.GET(req('GET'), { params: { id: invoice.id }, deps: ctx('dispatcher', DISP, { invoices: c.svc.db.invoices }).deps });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /TEST-1001_Invoice\.pdf/);
  assert.equal(new TextDecoder().decode((await r.arrayBuffer()).slice(0, 4)), '%PDF');
  assert.equal((await PDF.GET(req('GET'), { params: { id: invoice.id }, deps: ctx('driver', DRIVER, { invoices: c.svc.db.invoices }).deps })).status, 403);
});

test('load page: Invoice tab hidden for drivers; auto-draft migration fires on delivered', () => {
  const page = read('../../app/loads/[id]/page.js');
  assert.match(page, /showInvoice = invoiceTab && load\?\.viewer_role !== 'driver'/);
  const sql = read('../../supabase/migrations/20261021000200_invoice_autodraft.sql');
  assert.match(sql, /after update of status on public\.loads/);
  assert.match(sql, /exception when others/);
});

test('QA #1: load status rule — finalize moves any open load to Invoiced; cancelled / later stay; message only claims real changes', async () => {
  const { loadStatusAfter, loadStatusNote } = await import('../../app/lib/invoice.js');
  for (const s of ['booked', 'dispatched', 'in_transit', 'delivered']) assert.equal(loadStatusAfter('finalize', s), 'invoiced', s);
  for (const s of ['invoiced', 'paid', 'cancelled', 'weird']) assert.equal(loadStatusAfter('finalize', s), null, s);
  assert.equal(loadStatusAfter('paid', 'booked'), 'paid');
  assert.equal(loadStatusAfter('paid', 'cancelled'), null);
  assert.equal(loadStatusNote('booked', 'invoiced'), ' The load is now Invoiced.');
  assert.equal(loadStatusNote('booked', 'booked'), '');
  const c = ctx('owner', OWNER, { loads: [{ id: L1, user_id: OWNER, status: 'booked', rate: 2400, broker_load_number: 'TEST-1001' }] });
  await INV.PATCH(req('PATCH', { line_items: [{ type: 'linehaul', amount: 2400 }] }), { params: { id: L1 }, deps: c.deps });
  const j = await (await INV.POST(req('POST', { action: 'finalize' }), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(j.load.status, 'invoiced');
  assert.equal(j.loadStatusBefore, 'booked');
  assert.equal(c.svc.db.loads[0].status, 'invoiced', 'saved in the database, not just the response');
  const k = ctx('owner', OWNER, { loads: [{ id: L1, user_id: OWNER, status: 'cancelled', rate: 300, broker_load_number: 'TEST-TONU' }] });
  await INV.PATCH(req('PATCH', { line_items: [{ type: 'tonu', amount: 300 }] }), { params: { id: L1 }, deps: k.deps });
  const jk = await (await INV.POST(req('POST', { action: 'finalize' }), { params: { id: L1 }, deps: k.deps })).json();
  assert.equal(jk.load.status, 'cancelled');
  assert.match(read('../../app/components/InvoiceTab.js'), /loadStatusNote\(j\.loadStatusBefore, j\.load\?\.status\)/);
});

test('QA #5: terms shown on the draft are the terms finalize uses', async () => {
  // Auto-draft made without a broker (Net 30); a saved broker (Net 15) matches by name.
  const c = ctx('owner', OWNER, { invoices: [{ id: 'i-auto', owner_id: OWNER, load_id: L1, status: 'draft', broker_id: null, terms_days: 30, line_items: [{ type: 'linehaul', label: 'Linehaul', amount: 2400 }], total: 2400, bill_to: {}, created_at: '1' }] });
  const g = await (await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(g.invoice.terms_days, 15, 'the draft is refreshed to the matched broker’s terms before finalize');
  await INV.PATCH(req('PATCH', { terms_days: '45' }), { params: { id: L1 }, deps: c.deps });
  await INV.PATCH(req('PATCH', { notes: 'x' }), { params: { id: L1 }, deps: c.deps });
  assert.equal(c.svc.db.invoices[0].terms_days, 45, 'a save without terms keeps the draft’s terms');
  const j = await (await INV.POST(req('POST', { action: 'finalize' }), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(j.invoice.terms_days, 45, 'finalize keeps the draft’s terms');
});

test('nits: linehaul pre-filled from the rate; remit-to hint; broker auto-match is an exact saved-name match', () => {
  const ui = read('../../app/components/InvoiceTab.js');
  assert.match(ui, /Number\(j\.load\?\.rate\) > 0 \? \[\{ type: 'linehaul'/);
  assert.match(ui, /data-testid="remit-hint"/);
  assert.equal(brokerForLoad({ broker_name: 'SAMPLE TEST BROKER LLC' }, [broker]), null, 'no saved broker → no match (expected)');
  assert.equal(brokerForLoad({ broker_name: 'acme freight brokerage (fake) ' }, [broker]).id, B1);
});
