// Invoicing PR 3: bundle order/names, checks, email text, Mark as sent / paid / void, invoices list. Fake data only;
// nothing is emailed (no Postmark in these files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fakeSupabase } from './fakeSupabase.mjs';
import { bundleFiles, bundleChecks, emailText, recipientFor, statusChange, sizeCheck } from '../../app/lib/invoiceBundle.js';
import { buildBundlePdf, docToPdf } from '../../app/lib/invoiceBundlePdf.js';
import * as BUNDLE from '../../app/api/invoices/[id]/bundle/route.js';
import * as ACT from '../../app/api/invoices/[id]/route.js';
import * as LIST from '../../app/api/invoices/route.js';
import { invoiceMenuState, rememberInvoiceMenu, rememberedInvoiceMenu } from '../../app/lib/invoiceMenu.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', MGMT = '00000000-0000-4000-8000-0000000000a4', DISP = '00000000-0000-4000-8000-0000000000a5', DRIVER = '00000000-0000-4000-8000-0000000000a2';
const L1 = '00000000-0000-4000-8000-0000000000b1', I1 = '00000000-0000-4000-8000-0000000000c1', F1 = '00000000-0000-4000-8000-0000000000e1';
const inv0 = { id: I1, owner_id: OWNER, load_id: L1, status: 'ready', invoice_number: 'INV-1001', terms_days: 30, total: 2585, factored: false, bill_to: { name: 'Acme Freight Brokerage (fake)', emails: ['ap@example.com'] },
  load_ref: { load_number: 'TEST-1001' }, line_items: [{ type: 'linehaul', label: 'Linehaul', amount: 2400 }, { type: 'lumper', label: 'Lumper reimbursement', amount: 185 }] };
const docs = [
  { id: 'd3', doc_type: 'lumper_receipt', file_path: `${OWNER}/3-l.jpg`, created_at: '3' },
  { id: 'd2', doc_type: 'pod', file_path: `${OWNER}/2-pod.pdf`, created_at: '2' },
  { id: 'd1', doc_type: 'rate_confirmation', file_path: `${OWNER}/1-rc.pdf`, created_at: '1' },
  { id: 'd4', doc_type: 'pod', file_path: `${OWNER}/4-pod.heic`, created_at: '4' },
];

test('bundle order + names: invoice, rate con, POD(s), lumper; HEIC left out', () => {
  const f = bundleFiles(inv0, docs);
  assert.deepEqual(f.map((x) => x.name), ['TEST-1001_Invoice.pdf', 'TEST-1001_RateCon.pdf', 'TEST-1001_POD-1.pdf', 'TEST-1001_POD-2.pdf', 'TEST-1001_Lumper.pdf']);
  assert.equal(f[3].supported, false);
});

test('checks: missing POD / lumper receipt / scale ticket; detention reminder; rate mismatch; already sent', () => {
  assert.deepEqual(bundleChecks(inv0, docs.slice(0, 3)), []);
  const t = bundleChecks({ ...inv0, load_rate: 2300, line_items: [...inv0.line_items, { type: 'scale', amount: 12 }, { type: 'detention', amount: 50 }] }, [docs[2]], { otherSent: ['INV-1000'] }).map((c) => c.text).join(' | ');
  for (const m of ['No signed BOL/POD', 'no lumper receipt', 'no scale ticket', 'Detention is billed', 'doesn’t match', 'already invoiced as INV-1000']) assert.ok(t.includes(m), m);
  assert.equal(sizeCheck([{ size: 8e6 }]).ok, false);
});

test('email text: subject per the reference; factored note; recipient', () => {
  const e = emailText(inv0, { legal_name: 'FAKE Trucking LLC' }, bundleFiles(inv0, docs.slice(0, 3)));
  assert.equal(e.subject, 'Invoice INV-1001 / Load TEST-1001 / FAKE Trucking LLC');
  assert.match(e.body, /total \$2,585\.00, Net 30/);
  assert.match(e.body, /- TEST-1001_RateCon\.pdf/);
  assert.ok(!/assigned/.test(e.body));
  assert.match(emailText({ ...inv0, factored: true }, {}, []).body, /assigned/);
  assert.equal(recipientFor(inv0), 'ap@example.com');
  assert.equal(recipientFor({ factored: true }, { submission_email: 'submit@example.com' }), 'submit@example.com');
});

test('status changes: sent, paid, short-paid, void rules', () => {
  assert.ok(statusChange({ status: 'draft' }, 'mark_sent', { sent_to: 'x' }).error);
  assert.ok(statusChange(inv0, 'mark_sent', {}).error);
  assert.equal(statusChange(inv0, 'mark_sent', { sent_to: 'ap@example.com' }).patch.status, 'sent');
  assert.deepEqual(statusChange(inv0, 'paid', {}, '2026-11-01').patch, { status: 'paid', paid_amount: 2585, paid_at: '2026-11-01' });
  assert.equal(statusChange(inv0, 'paid', { paid_amount: '2,500' }).patch.status, 'short_paid');
  assert.ok(statusChange(inv0, 'void', {}).error);
  assert.equal(statusChange(inv0, 'void', { reason: 'wrong rate' }).patch.status, 'void');
  assert.ok(statusChange({ ...inv0, status: 'paid' }, 'void', { reason: 'x' }).error);
  assert.ok(statusChange({ ...inv0, status: 'void' }, 'paid', {}).error);
});

async function fakePdf(text) { const d = await PDFDocument.create(); d.addPage([200, 200]).drawText(text); return d.save(); }
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

test('merged PDF: invoice page + PDF pages + a photo page; unreadable files skipped', async () => {
  const files = { [`${OWNER}/1-rc.pdf`]: await fakePdf('rc'), [`${OWNER}/5-l.png`]: PNG };
  const dl = async (p) => files[p] || null;
  const list = [{ name: 'a', supported: true, doc: { file_path: `${OWNER}/1-rc.pdf` } }, { name: 'b', supported: true, doc: { file_path: `${OWNER}/5-l.png` } }, { name: 'c', supported: true, doc: { file_path: `${OWNER}/gone.pdf` } }];
  const r = await buildBundlePdf(await fakePdf('invoice'), list, dl);
  assert.equal((await PDFDocument.load(r.bytes)).getPageCount(), 3);
  assert.deepEqual(r.skipped, ['c']);
  assert.equal((await PDFDocument.load(await docToPdf({ file_path: `${OWNER}/5-l.png` }, dl))).getPageCount(), 1);
  assert.equal(await docToPdf({ file_path: 'x.heic' }, dl), null);
});

// ---- routes ----
function ctx(role, userId, { invoices = [{ ...inv0 }] } = {}) {
  const svc = fakeSupabase({ tables: {
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }], invoices, invoice_events: [],
    factors: [{ id: F1, owner_id: OWNER, name: 'Sample Factor Co', submission_email: 'submit@example.com', packet_format: 'separate' }],
    loads: [{ id: L1, user_id: OWNER, status: 'invoiced', rate: 2400 }],
    documents: docs.slice(0, 3).map((d) => ({ ...d, user_id: OWNER, load_id: L1 })),
  } });
  svc.storage.from = () => ({ list: async () => ({ data: [] }), download: async () => ({ data: null }) });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }) };
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const req = (method, body, q = '') => new Request(`http://x/api${q}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('bundle route: dispatcher can view files, checks and email text; driver 403', async () => {
  const j = await (await BUNDLE.GET(req('GET'), { params: { id: I1 }, deps: ctx('dispatcher', DISP).deps })).json();
  assert.deepEqual(j.files.map((f) => f.kind), ['invoice', 'rate_confirmation', 'pod', 'lumper_receipt']);
  assert.equal(j.email.to, 'ap@example.com');
  assert.equal(j.canEdit, false);
  assert.equal((await BUNDLE.GET(req('GET'), { params: { id: I1 }, deps: ctx('driver', DRIVER).deps })).status, 403);
  const inv = await BUNDLE.GET(req('GET', null, '?download=invoice'), { params: { id: I1 }, deps: ctx('owner', OWNER).deps });
  assert.equal(inv.headers.get('content-type'), 'application/pdf');
  assert.match(inv.headers.get('content-disposition'), /TEST-1001_Invoice\.pdf/);
});

test('factored invoice: goes to the factor; their format (separate) is used', async () => {
  const j = await (await BUNDLE.GET(req('GET'), { params: { id: I1 }, deps: ctx('owner', OWNER, { invoices: [{ ...inv0, factored: true, factor_id: F1 }] }).deps })).json();
  assert.equal(j.email.to, 'submit@example.com');
  assert.equal(j.format, 'separate');
});

test('actions: mark sent → paid (load → paid); events logged; dispatcher 403; void needs a reason', async () => {
  const c = ctx('management', MGMT);
  assert.equal((await ACT.POST(req('POST', { action: 'mark_sent', sent_to: 'ap@example.com', files: ['TEST-1001_Packet.pdf'] }), { params: { id: I1 }, deps: c.deps })).status, 200);
  assert.equal(c.svc.db.invoices[0].status, 'sent');
  assert.equal(c.svc.db.invoice_events[0].kind, 'marked_sent');
  assert.equal(c.svc.db.invoice_events[0].created_by, MGMT);
  assert.equal((await ACT.POST(req('POST', { action: 'void' }), { params: { id: I1 }, deps: c.deps })).status, 422);
  assert.equal((await ACT.POST(req('POST', { action: 'paid', paid_amount: '' }), { params: { id: I1 }, deps: c.deps })).status, 200);
  assert.equal(c.svc.db.invoices[0].status, 'paid');
  assert.equal(c.svc.db.loads[0].status, 'paid');
  assert.equal((await ACT.POST(req('POST', { action: 'mark_sent', sent_to: 'x' }), { params: { id: I1 }, deps: ctx('dispatcher', DISP).deps })).status, 403);
});

test('list (QA #6): counts per tab, Unpaid includes short-paid, unpaid total is the balance; driver 403', async () => {
  const invoices = [{ ...inv0 }, { ...inv0, id: 'i2', status: 'paid', invoice_number: 'INV-1002' }, { ...inv0, id: 'i3', status: 'draft', invoice_number: null },
    { ...inv0, id: 'i4', status: 'short_paid', invoice_number: 'INV-1003', total: 1000, paid_amount: 900 }, { ...inv0, id: 'i5', status: 'sent', invoice_number: 'INV-1004', total: 500 }];
  const j = await (await LIST.GET(req('GET'), { deps: ctx('dispatcher', DISP, { invoices }).deps })).json();
  assert.equal(j.invoices.length, 5);
  assert.deepEqual(j.counts, { all: 5, draft: 1, unpaid: 3, paid: 1, short_paid: 1, void: 0 });
  assert.equal(j.unpaidTotal, 2585 + 100 + 500);
  assert.equal((await LIST.GET(req('GET'), { deps: ctx('driver', DRIVER, { invoices }).deps })).status, 403);
  assert.match(read('../../app/invoices/page.js'), /\$\{st\.counts\[k\] \?\? 0\}/);
});

test('QA #1: Mark paid moves a Booked load to Paid and reports the status read back', async () => {
  const c = ctx('owner', OWNER);
  c.svc.db.loads[0].status = 'booked';
  const j = await (await ACT.POST(req('POST', { action: 'paid' }), { params: { id: I1 }, deps: c.deps })).json();
  assert.equal(j.loadStatusBefore, 'booked');
  assert.equal(j.loadStatus, 'paid');
  assert.equal(c.svc.db.loads[0].status, 'paid');
  const k = ctx('owner', OWNER); k.svc.db.loads[0].status = 'cancelled';
  const jk = await (await ACT.POST(req('POST', { action: 'paid' }), { params: { id: I1 }, deps: k.deps })).json();
  assert.equal(jk.loadStatus, 'cancelled');
  assert.match(read('../../app/components/InvoiceBundle.js'), /loadStatusNote\(j\.loadStatusBefore, j\.loadStatus\)/);
});

test('nit: copied email text starts with a To: line', () => {
  assert.match(read('../../app/components/InvoiceBundle.js'), /st\.email\.to \? `To: \$\{st\.email\.to\}\\n` : ''\}Subject:/);
});

test('no email sending in invoicing; Invoices menu item for office roles only', () => {
  for (const f of ['../../app/lib/invoiceBundle.js', '../../app/api/invoices/[id]/route.js', '../../app/api/invoices/[id]/bundle/route.js', '../../app/components/InvoiceBundle.js']) assert.ok(!/postmark|sendEmail/i.test(read(f)), f);
  const menu = read('../../app/components/ui/AccountMenu.js');
  assert.match(menu, /invoicesMenu === 'show' && \(\s*<Link href="\/invoices"/);
  assert.match(menu, /invoicesMenu === 'reserve' && <div aria-hidden="true"/);
});

test('Invoices menu entry: no jump while the role loads; drivers never get a link', () => {
  assert.equal(invoiceMenuState('owner', null), 'show');
  assert.equal(invoiceMenuState('dispatcher', '0'), 'show');
  assert.equal(invoiceMenuState('driver', '1'), 'hide');
  assert.equal(invoiceMenuState(null, '1'), 'show');
  assert.equal(invoiceMenuState(null, '0'), 'hide');
  assert.equal(invoiceMenuState(null, null), 'reserve');
  const m = new Map(); const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  rememberInvoiceMenu('u1', 'driver', st); assert.equal(rememberedInvoiceMenu('u1', st), '0');
  rememberInvoiceMenu('u2', 'management', st); assert.equal(rememberedInvoiceMenu('u2', st), '1');
  assert.equal(rememberedInvoiceMenu('u3', st), null);
});

test('void: drafts and short-paid invoices can be voided; fully paid cannot', () => {
  assert.equal(statusChange({ ...inv0, status: 'draft', invoice_number: null }, 'void', { reason: 'test data' }).patch.status, 'void');
  assert.ok(statusChange({ ...inv0, status: 'draft' }, 'mark_sent', { sent_to: 'x' }).error);
  assert.equal(statusChange({ ...inv0, status: 'short_paid' }, 'void', { reason: 'test data' }).patch.status, 'void');
  assert.ok(statusChange({ ...inv0, status: 'paid' }, 'void', { reason: 'x' }).error);
});

test('routes: void a short-paid invoice; delete a draft; voided load is not auto-drafted again', async () => {
  const c = ctx('management', MGMT, { invoices: [{ ...inv0, status: 'short_paid', paid_amount: 2500 }] });
  assert.equal((await ACT.POST(req('POST', { action: 'void', reason: 'test data' }), { params: { id: I1 }, deps: c.deps })).status, 200);
  assert.equal(c.svc.db.invoices[0].status, 'void');
  const INV = await import('../../app/api/loads/[id]/invoice/route.js');
  c.svc.db.loads[0].status = 'delivered';
  const g = await (await INV.GET(req('GET'), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(g.invoice, null, 'no new draft after a void');
  const d = ctx('owner', OWNER, { invoices: [{ ...inv0, status: 'draft', invoice_number: null }] });
  assert.equal((await INV.DELETE(req('DELETE'), { params: { id: L1 }, deps: d.deps })).status, 200);
  assert.equal(d.svc.db.invoices.length, 0);
  const f = ctx('owner', OWNER);
  assert.equal((await INV.DELETE(req('DELETE'), { params: { id: L1 }, deps: f.deps })).status, 409, 'finalized → use Void');
  assert.equal((await INV.DELETE(req('DELETE'), { params: { id: L1 }, deps: ctx('dispatcher', DISP).deps })).status, 403);
});
