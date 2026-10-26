// Load export packet (Marc, Oct 25). Fake data only; nothing is emailed (no Postmark, no fetch in this file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fakeSupabase } from './fakeSupabase.mjs';
import { showExport, canExportStatus, canExportRole, packetDocs, missingText, exportInvoice, packetFileName, looksLikeAccounting, prefillRecipient, exportOptions, planPacket, previewList, defaultSelection, selectionQuery } from '../../app/lib/loadExport.js';
import * as EXPORT from '../../app/api/loads/[id]/export/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DISP = '00000000-0000-4000-8000-0000000000a5', DRIVER = '00000000-0000-4000-8000-0000000000a2', MGMT = '00000000-0000-4000-8000-0000000000a4';
const L1 = '00000000-0000-4000-8000-0000000000b1';

async function onePagePdf(label) { const d = await PDFDocument.create(); d.addPage([612, 792]); d.setTitle(label); return new Uint8Array(await d.save()); }
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const DOCS = [
  { id: 'd2', doc_type: 'pod', file_path: `${OWNER}/2-pod.png`, original_filename: 'pod.png', created_at: '2' },
  { id: 'd1', doc_type: 'rate_confirmation', file_path: `${OWNER}/1-rc.pdf`, original_filename: 'rc.pdf', created_at: '1' },
  { id: 'd3', doc_type: 'bol', file_path: `${OWNER}/3-bol.pdf`, original_filename: 'bol.pdf', created_at: '3' },
  { id: 'd4', doc_type: 'lumper_receipt', file_path: `${OWNER}/4-l.pdf`, original_filename: 'lumper.pdf', created_at: '4' },
  { id: 'd5', doc_type: 'scale_ticket', file_path: `${OWNER}/5-s.jpg`, original_filename: 'scale.jpg', created_at: '5' },
  { id: 'd6', doc_type: 'load_photo', file_path: `${OWNER}/6-p.png`, original_filename: 'trailer.png', created_at: '6' },
  { id: 'd7', doc_type: 'other', file_path: `${OWNER}/7-x.heic`, original_filename: 'odd.heic', created_at: '7' },
];
const STOPS = [{ id: 's1', sequence: 1, stop_type: 'pickup', company_name: 'Fake Shipper', arrived_at: '2026-10-20T14:00:00Z', completed_at: '2026-10-20T15:00:00Z' }];

test('who and when: delivered or later, office roles only; never drivers, cancelled or booked', () => {
  for (const s of ['delivered', 'invoiced', 'paid']) assert.equal(canExportStatus(s), true, s);
  for (const s of ['booked', 'dispatched', 'in_transit', 'cancelled', undefined]) assert.equal(canExportStatus(s), false, String(s));
  for (const r of ['owner', 'management', 'dispatcher']) assert.equal(canExportRole(r), true, r);
  assert.equal(canExportRole('driver'), false);
  assert.equal(showExport({ status: 'delivered', viewer_role: null }), true, 'own load');
  assert.equal(showExport({ status: 'delivered', viewer_role: 'driver' }), false);
  assert.equal(showExport({ status: 'cancelled', viewer_role: 'owner' }), false);
});

test('packet order rate con, BOL, POD; lumper left out; missing and unreadable listed', () => {
  const p = packetDocs(DOCS);
  assert.deepEqual(p.files.map((d) => d.id), ['d1', 'd3', 'd2']);
  assert.deepEqual(p.missing, []);
  const q = packetDocs([DOCS[1], { id: 'h', doc_type: 'pod', file_path: 'x.heic' }]);
  assert.deepEqual(q.missing, ['bol']);
  assert.equal(q.unreadable.length, 1);
  assert.equal(missingText(['bol', 'pod']), 'No BOL and POD on this load, so they are not in the packet.');
  assert.equal(missingText([]), '');
});

test('invoice page: reuses the load invoice and its number; else an unnumbered draft from the load rate', () => {
  const inv = { id: 'i', status: 'ready', invoice_number: 'INV-1001' };
  assert.equal(exportInvoice({ load: {}, invoice: inv }), inv);
  const d = exportInvoice({ load: { id: L1, rate: 1250, broker_name: 'Fake Broker', broker_load_number: 'TEST-77' }, invoice: { status: 'void' }, profile: {} });
  assert.equal(d.invoice_number, null);
  assert.equal(d.status, 'draft');
  assert.deepEqual(d.line_items.map((l) => [l.type, l.amount]), [['linehaul', 1250]]);
  assert.equal(packetFileName({ broker_load_number: 'TEST 77' }, false), 'TEST-77_Packet-NoInvoice.pdf');
});

test('accounting addresses are never prefilled and are flagged', () => {
  for (const e of ['accounting@x.com', 'AP@x.com', 'ar@x.com', 'billing@x.com', 'invoices@x.com', 'payables@x.com', 'ap.team@x.com']) assert.equal(looksLikeAccounting(e), true, e);
  for (const e of ['jane@x.com', 'apple@x.com', 'dispatch@x.com', 'arnold@x.com']) assert.equal(looksLikeAccounting(e), false, e);
  assert.equal(prefillRecipient(['billing@x.com', 'not an email', 'Jane@X.com']), 'jane@x.com');
  assert.equal(prefillRecipient(['ap@x.com']), '');
});

function ctx(role, userId, { status = 'delivered', invoices = [], docs = DOCS } = {}) {
  const files = {};
  const svc = fakeSupabase({ tables: {
    company_profiles: [{ id: 'p1', owner_id: OWNER, legal_name: 'FAKE Trucking LLC' }], invoices, brokers: [], factors: [],
    loads: [{ id: L1, user_id: OWNER, status, rate: 990, broker_name: 'Fake Broker', broker_load_number: 'TEST-146', notes: 'FAKE: gate code 1234', stops: STOPS }],
    documents: docs.map((d) => ({ ...d, user_id: OWNER, load_id: L1 })), stop_delays: [],
  } });
  svc.storage.from = () => ({ download: async (p) => (files[p] ? { data: new Blob([files[p]]) } : { data: null }) });
  const uc = { ...svc, auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, rpc: async (fn) => ({ data: fn === 'packet_role' ? role : null, error: null }) };
  return { files, deps: { mkUserClient: () => uc, sb: svc } };
}
const req = (q = '') => new Request(`http://x/api${q}`, { headers: { authorization: 'Bearer t' } });

test('route: dispatcher info; driver 403; booked/cancelled 409', async () => {
  const j = await (await EXPORT.GET(req(), { params: { id: L1 }, deps: ctx('dispatcher', DISP).deps })).json();
  assert.deepEqual(j.options.docs.map((d) => d.type), ['rate_confirmation', 'bol', 'lumper_receipt', 'other', 'scale_ticket', 'pod', 'load_photo']);
  assert.equal(j.invoiceNumber, null);
  assert.equal((await EXPORT.GET(req(), { params: { id: L1 }, deps: ctx('driver', DRIVER).deps })).status, 403);
  for (const status of ['booked', 'cancelled']) assert.equal((await EXPORT.GET(req(), { params: { id: L1 }, deps: ctx('owner', OWNER, { status }).deps })).status, 409, status);
});

test('checklist defaults, order and preview', () => {
  const o = exportOptions({ load: { stops: STOPS, notes: 'n' }, docs: DOCS });
  assert.deepEqual(o.docs.map((d) => d.id), ['d1', 'd3', 'd4', 'd7', 'd5', 'd2', 'd6'], 'rate con, other, scale, POD, pictures');
  assert.deepEqual(o.docs.filter((d) => d.checked).map((d) => d.id), ['d1', 'd3', 'd5', 'd2', 'd6'], 'lumper/other opt-in');
  assert.equal(o.docs.find((d) => d.id === 'd7').supported, false);
  assert.equal(o.stopTimes.checked, true);
  assert.equal(o.loadNotes.available, true);
  assert.deepEqual(exportOptions({ load: { stops: [{ id: 'x' }] }, docs: [] }).stopTimes, { available: true, checked: false });
  const sel = { ...defaultSelection(o), docIds: [...defaultSelection(o).docIds, 'd4', 'd7'], loadNotes: true };
  assert.deepEqual(previewList(o, sel), ['Invoice', 'Rate confirmation: rc.pdf', 'BOL: bol.pdf', 'Lumper receipt: lumper.pdf', 'Scale ticket: scale.jpg', 'POD: pod.png', 'Load picture: trailer.png', 'Stop times', 'Notes']);
  const plan = planPacket({ load: { stops: STOPS, notes: 'n' }, docs: DOCS, sel });
  assert.deepEqual(plan.items.map((i) => i.label), previewList(o, sel), 'server order = preview');
  assert.deepEqual(plan.unsupported, ['odd.heic']);
  assert.match(selectionQuery(sel), /invoice=1&docs=d1%2Cd3/);
});

test('route: chosen items merge in order; images and PDFs; none selected → 422', async () => {
  const c = ctx('management', MGMT, { invoices: [{ id: 'i1', owner_id: OWNER, load_id: L1, status: 'ready', invoice_number: 'INV-1042', line_items: [], load_ref: {}, bill_to: {}, created_at: '1' }] });
  c.files[`${OWNER}/1-rc.pdf`] = await onePagePdf('rc'); c.files[`${OWNER}/3-bol.pdf`] = await onePagePdf('bol'); c.files[`${OWNER}/2-pod.png`] = PNG; c.files[`${OWNER}/6-p.png`] = PNG;
  const info = await (await EXPORT.GET(req(), { params: { id: L1 }, deps: c.deps })).json();
  assert.equal(info.invoiceNumber, 'INV-1042');
  const pages = async (q) => { const r = await EXPORT.GET(req(`?download=1&${q}`), { params: { id: L1 }, deps: c.deps }); return [r, r.status === 200 ? (await PDFDocument.load(new Uint8Array(await r.arrayBuffer()))).getPageCount() : 0]; };
  let [r, n] = await pages('invoice=1&docs=d1,d3,d2');
  assert.match(r.headers.get('content-disposition'), /TEST-146_Packet\.pdf/); assert.equal(n, 4);
  [r, n] = await pages('invoice=0&docs=d1,d3,d2');
  assert.match(r.headers.get('content-disposition'), /TEST-146_Packet-NoInvoice\.pdf/); assert.equal(n, 3);
  [r, n] = await pages('invoice=0&docs=d6,d7&stopTimes=1&loadNotes=1&note=Call%20before%20delivery');
  assert.equal(n, 3, 'picture + stop times + notes; heic skipped');
  assert.match(decodeURIComponent(r.headers.get('x-packet-skipped-names')), /odd\.heic/);
  [r, n] = await pages('invoice=0&docs=d5'); // scale.jpg not in storage: skipped, not failed
  assert.equal(r.headers.get('x-packet-skipped'), '1');
  assert.equal((await EXPORT.GET(req('?download=1&invoice=0&docs='), { params: { id: L1 }, deps: c.deps })).status, 422);
  assert.equal((await EXPORT.GET(req('?download=1&invoice=0&docs=not-mine'), { params: { id: L1 }, deps: c.deps })).status, 422, 'unknown ids ignored');
});

test('download never emails or writes: the export route and its builder never send or insert', () => {
  const src = read('../../app/api/loads/[id]/export/route.js') + read('../../app/lib/loadExportServer.js');
  assert.ok(!/postmark|packetSend|\.insert\(|\.update\(|method:\s*'POST'/i.test(src));
  assert.ok(!/postmark|\.insert\(/i.test(read('../../app/components/LoadExport.js')), 'the screen only calls the routes');
  assert.ok(!/\b(bot|AI)\b/.test(read('../../app/components/LoadExport.js').replace(/\/\/.*$/gm, '')));
  assert.match(read('../../app/loads/[id]/page.js'), /<LoadExport /);
});
