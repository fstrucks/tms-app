// Emailed rate con whose broker load number is already a load in the same account.
// Fake rows only. No network, no OpenAI, no Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { extractEmailRateCon, findExistingLoadMatch } from '../../app/lib/rateconEmail.js';
import { needsAttention } from '../../app/lib/docsInbox.js';
import {
  normalizeBrokerLoadNumber, existingLoadMatches, pickExistingLoad, reviewLoadMatch,
  linkExistingLoadLabel, linkDocumentToExistingLoad,
} from '../../app/lib/rateconMatch.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const DISP = '00000000-0000-4000-8000-0000000000a5';
const OTHER = '00000000-0000-4000-8000-0000000000a9';
const P1 = '00000000-0000-4000-8000-0000000000f1';
const L_OLD = '00000000-0000-4000-8000-0000000000b1';
const L_NEW = '00000000-0000-4000-8000-0000000000b2';
const L_OTHER = '00000000-0000-4000-8000-0000000000b9';
const DOC = '00000000-0000-4000-8000-0000000000c1';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('broker load numbers match trimmed and case-insensitive; the oldest load is the one already on the books', () => {
  assert.equal(normalizeBrokerLoadNumber('  6842063156 '), '6842063156');
  assert.equal(normalizeBrokerLoadNumber('Uber-99'), 'uber-99');
  assert.equal(normalizeBrokerLoadNumber('   '), '');
  assert.equal(normalizeBrokerLoadNumber(null), '');
  const loads = [
    { id: L_NEW, broker_load_number: '6842063156', created_at: '2026-10-02T00:00:00Z', status: 'booked' },
    { id: L_OLD, broker_load_number: ' 6842063156 ', created_at: '2026-08-01T00:00:00Z', status: 'delivered' },
    { id: L_OTHER, broker_load_number: '68420631560', created_at: '2026-01-01T00:00:00Z', status: 'delivered' },
  ];
  assert.deepEqual(existingLoadMatches(loads, '6842063156').map((l) => l.id).sort(), [L_NEW, L_OLD].sort());
  assert.equal(pickExistingLoad(loads, ' 6842063156 ').id, L_OLD);
  assert.equal(pickExistingLoad(loads, '68420631560').id, L_OTHER);
  assert.equal(pickExistingLoad(loads, ''), null);
  assert.equal(pickExistingLoad(loads, 'nope'), null);
  const frozen = JSON.parse(JSON.stringify(loads));
  pickExistingLoad(loads, '6842063156');
  assert.deepEqual(loads, frozen, 'matching does not change the load');
  assert.equal(linkExistingLoadLabel(loads[1]), 'Link to existing load #6842063156');
  assert.equal(linkExistingLoadLabel({ id: L_OLD, broker_load_number: ' Uber-99 ' }), 'Link to existing load #Uber-99');
});

test('review offers the existing load only while the document is still unlinked', () => {
  const loads = [{ id: L_OLD, broker_load_number: '6842063156', status: 'delivered', created_at: '2026-08-01T00:00:00Z' }];
  const draft = { id: DOC, source: 'email', load_id: null, doc_type: 'rate_confirmation', ai_extracted_data: { load_number: '6842063156' } };
  assert.equal(reviewLoadMatch(draft, loads).id, L_OLD);
  assert.equal(reviewLoadMatch({ ...draft, ai_extracted_data: { load_number: ' 6842063156 ' } }, loads).id, L_OLD);
  assert.equal(reviewLoadMatch({ ...draft, load_id: L_OLD }, loads), null);
  assert.equal(reviewLoadMatch({ ...draft, ai_extracted_data: { load_number: 'OTHER' } }, loads), null);
  assert.equal(needsAttention({ ...draft, load_id: L_OLD }), false);
  assert.equal(needsAttention(draft), true);
});

test('link request writes the document only: body is { loadId }', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, method: init.method, body: init.body };
    return { ok: true, json: async () => ({ document: { load_id: L_OLD } }) };
  };
  const r = await linkDocumentToExistingLoad(fetchImpl, { docId: DOC, loadId: L_OLD, token: 'fake-token' });
  assert.deepEqual(r, { ok: true, loadId: L_OLD });
  assert.equal(sent.method, 'PATCH');
  assert.equal(sent.url, `/api/documents/${DOC}/load`);
  assert.equal(sent.body, JSON.stringify({ loadId: L_OLD }));
  const fail = await linkDocumentToExistingLoad(async () => { throw new Error('offline'); }, { docId: DOC, loadId: L_OLD, token: 't' });
  assert.equal(fail.ok, false);
});

const rc = (loadNumber) => ({
  document_kind: 'rate_confirmation', heading_text: 'RATE CONFIRMATION', broker_name: 'FAKE Freight',
  load_number: loadNumber, reference_numbers: null, shipper: null, receiver: null,
  pickup: { date: '2026-10-20', time: null, address: 'Dallas, TX' },
  delivery: { date: '2026-10-21', time: null, address: 'Austin, TX' },
  rate: 1800, equipment_type: 'Dry van', weight: '38,500 lbs', total_miles: 196, notes: null,
});

function sbFor({ userId = OWNER, loads = [], profiles = [], members = [] } = {}) {
  const sb = fakeSupabase({
    tables: {
      documents: [{ id: DOC, user_id: userId, source: 'email', doc_type: 'rate_confirmation', load_id: null, extraction_status: 'pending', file_path: `${userId}/ratecons/fake.pdf` }],
      extraction_runs: [],
      loads,
      company_profiles: profiles,
      company_members: members,
    },
  });
  sb.rpc = async (fn) => (fn === 'claim_extraction_slot' ? { data: 'run-1', error: null } : { data: null, error: null });
  return sb;
}

async function readDoc(sb, loadNumber, userId = OWNER) {
  await extractEmailRateCon({
    sb, userId, docId: DOC, bytes: Buffer.from('%PDF-1.4 fake'), name: 'FAKE.pdf',
    deps: { env: { OPENAI_API_KEY: 'test-not-real' }, pdfText: async () => '', callModel: async () => ({ ok: true, extracted: rc(loadNumber) }) },
  });
  return sb.db.documents[0];
}

test('parsed rate con links to the completed load with the same broker load number and does not change that load', async () => {
  const load = {
    id: L_OLD, user_id: OWNER, broker_load_number: ' 6842063156 ', status: 'delivered',
    broker_name: 'Uber Freight (FAKE)', rate: 2400, notes: 'leave this', created_at: '2026-08-01T00:00:00Z',
  };
  const other = { id: L_OTHER, user_id: OTHER, broker_load_number: '6842063156', status: 'delivered', rate: 1, created_at: '2026-01-01T00:00:00Z' };
  const sb = sbFor({ loads: [load, other] });
  const before = JSON.parse(JSON.stringify(sb.db.loads));
  const doc = await readDoc(sb, '6842063156');
  assert.equal(doc.extraction_status, 'done');
  assert.equal(doc.load_id, L_OLD);
  assert.equal(doc.ai_extracted_data.load_number, '6842063156');
  assert.equal(needsAttention(doc), false);
  assert.deepEqual(sb.db.loads, before);
  assert.equal(sb.calls.filter((c) => c.t === 'loads' && c.op !== 'select').length, 0);
  assert.ok(!sb.calls.some((c) => c.op === 'insert' && c.t === 'loads'));
  const link = sb.calls.find((c) => c.t === 'documents' && c.op === 'update' && c.payload?.load_id);
  assert.deepEqual(link.payload, { load_id: L_OLD });
});

test('case and surrounding spaces match; a different number and another account do not', async () => {
  const sb = sbFor({
    loads: [
      { id: L_OLD, user_id: OWNER, broker_load_number: 'Uber-99', status: 'invoiced', created_at: '2026-08-01T00:00:00Z' },
      { id: L_OTHER, user_id: OTHER, broker_load_number: 'UBER-99', status: 'delivered', created_at: '2026-01-01T00:00:00Z' },
    ],
  });
  const before = JSON.parse(JSON.stringify(sb.db.loads));
  const doc = await readDoc(sb, '  uber-99 ');
  assert.equal(doc.load_id, L_OLD);
  assert.deepEqual(sb.db.loads, before);

  const miss = sbFor({ loads: [{ id: L_OLD, user_id: OWNER, broker_load_number: '68420631560', status: 'delivered', created_at: '2026-08-01T00:00:00Z' }] });
  const unmatched = await readDoc(miss, '6842063156');
  assert.equal(unmatched.load_id, null);
  assert.equal(unmatched.extraction_status, 'done');
  assert.equal(needsAttention(unmatched), true);
});

test('a dispatcher email matches the company owner’s load, not another company’s load', async () => {
  const owned = { id: L_OLD, user_id: OWNER, broker_load_number: '6842063156', status: 'paid', rate: 900, notes: 'owner load', created_at: '2026-07-01T00:00:00Z' };
  const stranger = { id: L_OTHER, user_id: OTHER, broker_load_number: '6842063156', status: 'delivered', created_at: '2026-01-01T00:00:00Z' };
  const sb = sbFor({
    userId: DISP,
    loads: [stranger, owned],
    profiles: [{ id: P1, owner_id: OWNER, legal_name: 'FAKE Trucking' }],
    members: [{ profile_id: P1, user_id: DISP, role: 'dispatcher' }],
  });
  const before = JSON.parse(JSON.stringify(sb.db.loads));
  const doc = await readDoc(sb, '6842063156', DISP);
  assert.equal(doc.load_id, L_OLD);
  assert.equal(doc.user_id, DISP);
  assert.deepEqual(sb.db.loads, before);
  const found = await findExistingLoadMatch(sb, DISP, '6842063156');
  assert.equal(found.id, L_OLD);
  const loner = '00000000-0000-4000-8000-0000000000aa';
  assert.equal(await findExistingLoadMatch(sb, loner, '6842063156'), null);
});

test('two loads with the same number: link the oldest, still do not create or edit a load', async () => {
  const sb = sbFor({
    loads: [
      { id: L_NEW, user_id: OWNER, broker_load_number: '6842063156', status: 'booked', created_at: '2026-10-20T00:00:00Z', rate: 2 },
      { id: L_OLD, user_id: OWNER, broker_load_number: '6842063156', status: 'delivered', created_at: '2026-08-01T00:00:00Z', rate: 1 },
    ],
  });
  const before = JSON.parse(JSON.stringify(sb.db.loads));
  const doc = await readDoc(sb, '6842063156');
  assert.equal(doc.load_id, L_OLD);
  assert.deepEqual(sb.db.loads, before);
  assert.equal(sb.db.loads.length, 2);
});

test('no broker load number, or a failed read, does not link and does not create a load', async () => {
  const load = { id: L_OLD, user_id: OWNER, broker_load_number: '6842063156', status: 'delivered', created_at: '2026-08-01T00:00:00Z' };
  const sb = sbFor({ loads: [load] });
  const doc = await readDoc(sb, '   ');
  assert.equal(doc.load_id, null);
  assert.equal(sb.db.loads.length, 1);
  assert.equal(sb.db.loads[0].broker_load_number, '6842063156');

  const sb2 = sbFor({ loads: [load] });
  await extractEmailRateCon({
    sb: sb2, userId: OWNER, docId: DOC, bytes: Buffer.from('%PDF-1.4 fake'), name: 'FAKE.pdf',
    deps: { env: { OPENAI_API_KEY: 'test-not-real' }, pdfText: async () => '', callModel: async () => ({ ok: true, extracted: { ...rc('6842063156'), document_kind: 'other' } }) },
  });
  assert.equal(sb2.db.documents[0].load_id, null);
  assert.equal(sb2.db.documents[0].extraction_error, 'not_ratecon');
  assert.equal(sb2.calls.filter((c) => c.t === 'loads' && c.op !== 'select').length, 0);
});

test('Needs attention review renders Link to existing load #X, and the backfill only updates documents', () => {
  const page = read('../../app/documents/page.js');
  assert.match(page, /data-testid="link-existing-load"/);
  assert.match(page, /linkExistingLoadLabel\(reviewLoadMatch\(d, accountLoads\)\)/);
  assert.match(page, /minHeight: 44/);
  assert.match(page, /linkDocumentToExistingLoad\(fetch,/);
  assert.match(page, /The load itself stays as it is/);
  const sql = read('../../supabase/one-off/20261024_link_unhandled_ratecons.sql');
  assert.match(sql, /NOT APPLIED/);
  assert.match(sql, /lower\(btrim\(l\.broker_load_number\)\)/);
  assert.match(sql, /lower\(btrim\((?:r|u)\.ai_extracted_data->>'load_number'\)\)/);
  assert.match(sql, /attention_reason/);
  assert.match(sql, /will_link/);
  assert.match(sql, /update public\.documents d/);
  assert.match(sql, /set load_id = c\.load_id/);
  assert.doesNotMatch(sql, /update\s+public\.loads/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.loads/i);
  assert.doesNotMatch(sql, /delete\s+from/i);
  const updates = sql.match(/update\s+public\.\w+/gi) || [];
  assert.deepEqual(updates.map((s) => s.toLowerCase()), ['update public.documents']);
});
