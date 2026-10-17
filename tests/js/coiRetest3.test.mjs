import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saveDocType } from '../../app/lib/docTypes.js';
import { suggestedExpiredLabel, suggestedExpiredNotes, atLeast } from '../../app/lib/coiRequest.js';
import { laToday } from '../../app/lib/sendCap.js';
import { PATCH } from '../../app/api/documents/[id]/type/route.js';

const ID = '00000000-0000-4000-8000-0000000000d3';
function fakeSb(doc) {
  const q = { _f: {}, select() { return q; }, eq() { return q; }, update(v) { q._u = v; return q; },
    maybeSingle: async () => ({ data: doc, error: null }), then(r) { if (q._u) Object.assign(doc, q._u); q._u = null; return Promise.resolve({ error: null }).then(r); } };
  return { from: () => q };
}
const req = (docType) => new Request(`http://x/api/documents/${ID}/type`, { method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ docType }) });
const uc = (role) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) }, rpc: async () => ({ data: role }) });

test('change-type route: driver gets 403 and the type is not changed', async () => {
  const doc = { id: ID, user_id: 'owner1', doc_type: 'rate_confirmation' };
  const res = await PATCH(req('coi'), { params: { id: ID }, deps: { sb: fakeSb(doc), mkUserClient: uc('driver') } });
  assert.equal(res.status, 403);
  assert.equal(doc.doc_type, 'rate_confirmation');
});

test('change-type route: owner success returns the saved row from the server', async () => {
  const doc = { id: ID, user_id: 'owner1', doc_type: 'rate_confirmation' };
  const res = await PATCH(req('coi'), { params: { id: ID }, deps: { sb: fakeSb(doc), mkUserClient: uc('owner') } });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(j.document, { id: ID, doc_type: 'coi' });
  assert.equal(doc.doc_type, 'coi');
});

test('saveDocType: network error (ERR_CONNECTION_CLOSED) → ok:false with an error, no throw', async () => {
  const r = await saveDocType({ id: ID, docType: 'coi', token: 't', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(r.ok, false); assert.match(r.error, /Type not changed/);
});

test('saveDocType: non-2xx → ok:false with server error text', async () => {
  const r = await saveDocType({ id: ID, docType: 'coi', fetchImpl: async () => new Response(JSON.stringify({ error: 'Only the owner or management can change a document’s type.' }), { status: 403 }) });
  assert.equal(r.ok, false); assert.match(r.error, /owner or management/);
  const r2 = await saveDocType({ id: ID, docType: 'coi', fetchImpl: async () => new Response('<html>', { status: 502 }) });
  assert.equal(r2.ok, false); assert.match(r2.error, /error 502/);
});

test('saveDocType: success uses the server-returned type, not the requested one', async () => {
  const r = await saveDocType({ id: ID, docType: 'coi', fetchImpl: async () => new Response(JSON.stringify({ ok: true, docType: 'bol', document: { id: ID, doc_type: 'bol' } }), { status: 200 }) });
  assert.deepEqual(r, { ok: true, docType: 'bol', offerRead: false });
});

test('documents page: failure keeps the old type and shows inline error + Retry', () => {
  const src = readFileSync(new URL('../../app/documents/page.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function changeType'), src.indexOf('useEffect(() => { const t = uploadTypeFromQuery'));
  assert.match(fn, /if \(!r\.ok\) return setTypeErr/);
  assert.ok(fn.indexOf('setTypeErr') < fn.indexOf('setDocs'), 'docs only updated after a successful save');
  assert.match(fn, /doc_type: r\.docType/);
  assert.match(src, /data-testid="change-type-error"/);
  assert.match(src, /data-testid="change-type-retry"[^>]*onClick=\{\(\) => changeType\(d, typeErr\[d\.id\]\.docType\)\}/);
});

test('suggested expired policies are flagged with MM/DD; confirmed or current are not', () => {
  const p = { coverage: 'cargo', policy_number: 'FAKE-CG-0002', expiry_date: '2026-10-15', confirmed: false };
  assert.equal(suggestedExpiredLabel(p, '2026-10-17'), 'Suggested, expired 10/15');
  assert.equal(suggestedExpiredLabel({ ...p, confirmed: true }, '2026-10-17'), null);
  assert.equal(suggestedExpiredLabel({ ...p, expiry_date: '2027-01-01' }, '2026-10-17'), null);
  assert.equal(suggestedExpiredLabel({ ...p, expiry_date: null }, '2026-10-17'), null);
  const n = suggestedExpiredNotes([p, { ...p, coverage: 'auto_liability', expiry_date: '2027-01-01' }], '2026-10-17');
  assert.equal(n.length, 1); assert.equal(n[0].code, 'suggested_expired');
  assert.match(n[0].text, /cargo policy FAKE-CG-0002 expired 10\/15/);
});

test('company page wires the expired-suggested badge and gap note', () => {
  const src = readFileSync(new URL('../../app/company/CompanyInsurance.js', import.meta.url), 'utf8');
  assert.match(src, /data-testid="suggested-expired"/);
  assert.match(src, /concat\(suggestedExpiredNotes\(st\.policies, laToday\(\)\)\)/);
  assert.match(src, /atLeast\(api\('\/api\/company\/insurance\/suggest'/);
});

test('atLeast keeps busy for the minimum time and returns the value', async () => {
  const waits = []; const v = await atLeast(Promise.resolve(7), 600, async (t) => { waits.push(t); });
  assert.equal(v, 7); assert.deepEqual(waits, [600]);
  assert.match(laToday(new Date('2026-10-18T03:00:00Z')), /^2026-10-17$/);
});
