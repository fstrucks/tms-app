// Scanner accepts PDFs directly (stored as-is) + server PDF check. Fake files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { pdfProblem, pdfFileProblem, pdfUploadName, looksLikePdfFile, PDF_ACCEPT } from '../../app/lib/pdfFile.js';
import { PDF_MAX_BYTES } from '../../app/lib/scan.js';
import { uploadScan } from '../../app/lib/scanUpload.js';
import { bundleFiles } from '../../app/lib/invoiceBundle.js';
import { isImagePath } from '../../app/lib/loadDocs.js';
import * as CHECK from '../../app/api/documents/[id]/check-pdf/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const U = '00000000-0000-4000-8000-0000000000a2', U2 = '00000000-0000-4000-8000-0000000000a3', D1 = '00000000-0000-4000-8000-0000000000e1';
const PDF = new TextEncoder().encode('%PDF-1.4\n% FAKE TEST BOL\n%%EOF\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);

test('PDF rules: magic bytes, 10 MB limit (same as scans), name kept and safe', async () => {
  assert.equal(pdfProblem(PDF.length, PDF.subarray(0, 5)), null);
  assert.equal(pdfProblem(5, PNG), 'not_pdf');
  assert.equal(pdfProblem(PDF_MAX_BYTES + 1, PDF), 'too_large');
  assert.equal(pdfProblem(0, new Uint8Array()), 'empty');
  assert.equal(await pdfFileProblem(new File([PDF], 'TEST-1 BOL.pdf', { type: 'application/pdf' })), null);
  assert.equal(await pdfFileProblem(new File([PNG], 'x.pdf', { type: 'application/pdf' })), 'not_pdf', 'renamed image');
  assert.equal(await pdfFileProblem(new File([PDF], 'x.png', { type: 'image/png' })), 'not_pdf');
  assert.ok(looksLikePdfFile({ name: 'A.PDF', type: '' }));
  assert.equal(pdfUploadName('Broker RC #123 (final).PDF'), 'Broker_RC_123_final.pdf');
  assert.equal(PDF_ACCEPT, 'application/pdf,.pdf');
});

function ctx(userId, file = PDF) {
  const svc = fakeSupabase({ tables: { documents: [{ id: D1, user_id: U, file_path: `${U}/1-bol.pdf`, doc_type: 'bol' }] } });
  const removed = [];
  svc.storage.from = () => ({ download: async () => ({ data: new Blob([file]), error: null }), remove: async (p) => { removed.push(...p); return { error: null }; } });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: U }] }, user: { id: userId }, role: 'owner' });
  return { svc, removed, deps: { mkUserClient: () => uc, sb: svc } };
}
const check = async (c) => { const r = await CHECK.POST(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer t' } }), { params: { id: D1 }, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('server check: real PDF ok; non-PDF removed (file + row); someone else’s doc 404', async () => {
  let c = ctx(U); assert.equal((await check(c)).status, 200); assert.equal(c.svc.db.documents.length, 1);
  c = ctx(U, PNG); const r = await check(c);
  assert.equal(r.status, 422); assert.equal(r.j.reason, 'not_pdf'); assert.deepEqual(c.removed, [`${U}/1-bol.pdf`]); assert.equal(c.svc.db.documents.length, 0);
  assert.equal((await check(ctx(U2))).status, 404);
});

test('uploadScan: checks the PDF before linking; a failed check stops it', async () => {
  const mk = () => { const sb = fakeSupabase({ tables: { documents: [] }, user: { id: U } }); sb.storage.from = () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }); sb.auth.getSession = async () => ({ data: { session: { access_token: 't' } } }); return sb; };
  const calls = [];
  const ok = async (url) => { calls.push(url); return new Response('{}', { status: 200 }); };
  assert.equal(await uploadScan(mk(), U, { file: new File([PDF], 'b.pdf'), docType: 'bol', loadId: 'L1' }, { fetchImpl: ok }), null);
  assert.ok(/check-pdf$/.test(calls[0])); assert.ok(/\/load$/.test(calls[1]));
  calls.length = 0;
  const bad = async (url) => { calls.push(url); return url.endsWith('check-pdf') ? new Response(JSON.stringify({ error: 'That file isn’t a PDF.' }), { status: 422 }) : new Response('{}'); };
  assert.equal(await uploadScan(mk(), U, { file: new File([PNG], 'b.pdf'), docType: 'bol', loadId: 'L1' }, { fetchImpl: bad }), 'That file isn’t a PDF.');
  assert.equal(calls.length, 1, 'not linked');
});

test('PDF shows / opens like scans and goes in the packet', () => {
  assert.equal(isImagePath(`${U}/1-Broker_BOL.pdf`), false);
  const f = bundleFiles({ load_ref: { load_number: 'TEST-1' } }, [{ id: 'd', doc_type: 'bol', file_path: `${U}/1-Broker_BOL.pdf`, created_at: '1' }]);
  assert.equal(f[1].supported, true); assert.equal(f[1].name, 'TEST-1_BOL.pdf');
});

test('Scanner wiring: Choose PDF input, as-is upload path, photos and PDF not mixed', () => {
  const s = read('../../app/components/scanner/Scanner.js');
  assert.match(s, /type="file" accept=\{PDF_ACCEPT\}/); assert.match(s, /data-testid="scan-choose-pdf"/);
  assert.match(s, /if \(pdf\) \{[\s\S]*new File\(\[pdf\], pdfUploadName\(pdf\.name\)/);
  assert.match(s, /Save or delete the photo pages first, then choose a PDF\./);
  assert.match(s, /const uploadOff = !\(n \|\| pdf\)/);
});
