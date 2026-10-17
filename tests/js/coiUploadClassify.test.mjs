import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyDocText, decideDocKind, docKindScores } from '../../app/lib/docClassify.js';
import { UPLOAD_TYPES, uploadTypeFromQuery } from '../../app/lib/docTypes.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ACORD = `ACORD CERTIFICATE OF LIABILITY INSURANCE DATE (MM/DD/YYYY) 10/17/2026 THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY
PRODUCER Fake Agency (TEST) INSURED Test Trucking LLC (FAKE) INSURER(S) AFFORDING COVERAGE INSURER A : Fake Mutual Insurance Co INSURER B : Test Cargo Co
AUTOMOBILE LIABILITY COMBINED SINGLE LIMIT $1,000,000 MOTOR TRUCK CARGO $100,000 POLICY EFF POLICY EXP CERTIFICATE HOLDER Test Broker LLC (FAKE) ACORD 25 (2016/03)`;
const RATECON = `RATE CONFIRMATION Test Broker LLC (FAKE) MC# 000000 Load # 12345 Carrier: Test Trucking LLC Shipper: Acme Foods DC Pickup 10/20/2026 08:00
Consignee: Fake Grocery Delivery 10/21/2026 Equipment: 53' Dry Van Line Haul $2,000.00 Total Rate $2,150.00 Detention $50/hr`;
// Rate cons often mention insurance requirements; must still classify as rate con.
const RATECON_WITH_INS = RATECON + ' Carrier must maintain $1,000,000 auto liability and $100,000 cargo; certificate of insurance with broker as certificate holder required.';

test('classifier: ACORD 25 COI → coi; rate cons stay rate_confirmation', () => {
  assert.equal(classifyDocText(ACORD), 'coi');
  assert.equal(classifyDocText(ACORD.toLowerCase()), 'coi');
  assert.equal(classifyDocText('CERTIFICATE OF LIABILITY INSURANCE PRODUCER INSURER A CERTIFICATE HOLDER'), 'coi');
  assert.equal(classifyDocText(RATECON), 'rate_confirmation');
  assert.equal(classifyDocText(RATECON_WITH_INS), 'rate_confirmation');
  assert.equal(classifyDocText(''), null);
  assert.equal(classifyDocText('Bill of lading'), null);
  assert.ok(docKindScores(ACORD).coi >= 10);
});

test('decideDocKind: PDF text first, then AI kind/heading; default rate con', () => {
  assert.equal(decideDocKind({ pdfText: ACORD, aiKind: 'rate_confirmation' }), 'coi');
  assert.equal(decideDocKind({ pdfText: RATECON, aiKind: 'coi' }), 'rate_confirmation');
  assert.equal(decideDocKind({ aiKind: 'coi' }), 'coi'); // photo of a COI (no text layer)
  assert.equal(decideDocKind({ aiText: 'CERTIFICATE OF LIABILITY INSURANCE, PRODUCER, INSURER A, CERTIFICATE HOLDER' }), 'coi');
  assert.equal(decideDocKind({ aiKind: 'coi', aiText: 'RATE CONFIRMATION Load # 1 Shipper Consignee Line haul' }), 'rate_confirmation');
  assert.equal(decideDocKind({ aiKind: 'rate_confirmation', aiText: 'RATE CONFIRMATION' }), 'rate_confirmation');
  assert.equal(decideDocKind({}), 'rate_confirmation');
});

test('upload types include COI; ?type=coi presets it; unknown ignored', () => {
  assert.ok(UPLOAD_TYPES.some((t) => t.id === 'coi'));
  assert.equal(UPLOAD_TYPES[0].id, 'rate_confirmation');
  assert.ok(!UPLOAD_TYPES.some((t) => t.id === 'other'));
  assert.equal(uploadTypeFromQuery('?type=coi'), 'coi');
  assert.equal(uploadTypeFromQuery('?type=hack'), null);
  assert.equal(uploadTypeFromQuery(''), null);
});

test('wiring: documents page type picker + only rate cons extracted; extract route reclassifies COIs; Insurance has Upload COI', () => {
  const doc = read('../../app/documents/page.js');
  assert.match(doc, /id="upload-type"/); assert.match(doc, /doc_type: docType/);
  assert.match(doc, /docType === 'rate_confirmation'\) extract\(/); assert.match(doc, /body\.reclassified === 'coi'/);
  const r = read('../../app/api/extract/route.js');
  assert.match(r, /document_kind: \{ type: 'string', enum: \['rate_confirmation', 'coi', 'other'\]/);
  assert.match(r, /required: \['document_kind', 'heading_text',/);
  assert.match(r, /classifyDocText\(pdfText\) === 'coi'\) return reclassifyCoi/);
  assert.match(r, /decideDocKind\(\{ pdfText, aiKind, aiText \}\) === 'coi'/);
  assert.match(r, /update\(\{ doc_type: 'coi', ai_extracted_data: null \}\)/);
  const ins = read('../../app/company/CompanyInsurance.js');
  assert.match(ins, /href="\/documents\?type=coi"/); assert.match(ins, />Upload COI</);
  assert.doesNotMatch(ins, /type “COI”\), then/);
});
