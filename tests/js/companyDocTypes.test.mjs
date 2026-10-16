// Marc 10/15: load-page scans offer BOL/POD/Lumper; W-9 / COI / MC Authority are company docs -> Load defaults to "No load". Other stays off the load page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCAN_DOC_TYPES, COMPANY_DOC_TYPE_IDS, isCompanyDocType, LOAD_SCAN_TYPE_IDS, uploadButtonLabel, docTypeLabel } from '../../app/lib/docTypes.js';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
const sc = read('../../app/components/scanner/Scanner.js');
const load = read('../../app/loads/[id]/page.js');

test('company types exist with the agreed labels; keys unchanged (no SQL)', () => {
  const by = Object.fromEntries(SCAN_DOC_TYPES.map((t) => [t.id, t.label]));
  assert.equal(by.w9, 'W-9');
  assert.equal(by.coi, 'Certificate of Insurance (COI)');
  assert.equal(by.mc_authority, 'MC Authority');
  assert.deepEqual(COMPANY_DOC_TYPE_IDS, ['w9', 'coi', 'mc_authority']);
  for (const id of ['bol', 'pod', 'lumper_receipt', 'other', 'ratecon']) assert.equal(isCompanyDocType(id), false, id);
  assert.equal(docTypeLabel('coi'), 'Certificate of Insurance (COI)');
});

test('upload label still follows the type', () => {
  assert.equal(uploadButtonLabel('w9'), 'Upload W-9');
  assert.equal(uploadButtonLabel('coi'), 'Upload COI');
  assert.equal(uploadButtonLabel('mc_authority'), 'Upload MC Authority');
  assert.equal(uploadButtonLabel('bol'), 'Upload BOL');
});

test('load page Scan offers BOL, POD and Lumper receipt (Other stays off)', () => {
  assert.deepEqual(LOAD_SCAN_TYPE_IDS, ['bol', 'pod', 'lumper_receipt']);
  assert.ok(!LOAD_SCAN_TYPE_IDS.includes('other'));
  assert.match(load, /<Scanner[\s\S]*?initialLoadId=\{load\.id\}\s*typeIds=\{LOAD_SCAN_TYPE_IDS\}/);
  assert.match(sc, /const baseTypes = typeIds \? SCAN_DOC_TYPES\.filter\(\(t\) => typeIds\.includes\(t\.id\)\) : SCAN_DOC_TYPES;/);
  assert.match(sc, /const typeOptions = allowRateCon \? \[RATECON_TYPE, \.\.\.baseTypes\] : baseTypes;/);
});

test('picking a company type sets Load to No load; Load stays editable; #54 behaviour kept', () => {
  assert.match(sc, /setDocType\(v\); setTypeErr\(false\); if \(isCompanyDocType\(v\)\) setLoadId\(''\);/);
  assert.match(sc, /<select value=\{loadId\} onChange=\{\(e\) => setLoadId\(e\.target\.value\)\}/);
  assert.match(sc, /const \[docType, setDocType\] = useState\(''\);/);
  assert.match(sc, /if \(!docType\) \{ setTypeErr\(true\); typeRef\.current\?\.focus\(\); return; \}/);
});
