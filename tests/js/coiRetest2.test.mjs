import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSuggestions, duplicateSuggestionIds, policyKey, companyGapNotes, suggestMessage } from '../../app/lib/coiRequest.js';
import { coiGaps } from '../../app/lib/coiGaps.js';
import { capLabel } from '../../app/lib/sendCap.js';
import { canChangeDocType } from '../../app/lib/docTypes.js';
import { defaultCoiDraft } from '../../app/lib/coiTemplate.js';
import * as SUG from '../../app/api/company/insurance/suggest/route.js';
import * as TYPE from '../../app/api/documents/[id]/type/route.js';
import * as COI from '../../app/api/packets/[id]/coi-request/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DOC = '00000000-0000-4000-8000-0000000000d1', DOC2 = '00000000-0000-4000-8000-0000000000d2';
const PID = '00000000-0000-4000-8000-0000000000aa';

function fakeSb(seed = {}) {
  const tbl = { company_profiles: [{ id: 'cp1', owner_id: 'owner1' }], insurance_policies: [], documents: [], packets: [], coi_requests: [], packet_sends: [], insurance_agents: [], ...seed };
  let n = 0, clock = 0;
  const from = (name) => { const st = { op: 'select', f: [] }; const run = () => { tbl[name] ||= [];
    if (st.op === 'insert') { const list = Array.isArray(st.payload) ? st.payload : [st.payload]; const added = list.map((p) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, created_at: `2026-10-17T00:00:${String(++clock).padStart(2, '0')}Z`, ...p })); tbl[name].push(...added); return { data: added, error: null }; }
    const rows = tbl[name].filter((r) => st.f.every(([k, v]) => r[k] === v));
    if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows, error: null }; }
    if (st.op === 'delete') { tbl[name] = tbl[name].filter((r) => !rows.includes(r)); return { error: null }; }
    return { data: st.one ? rows[0] || null : rows, count: rows.length, error: null }; };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, gte() { return b; }, order() { return b; }, limit() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) }; return b; };
  return { from, tbl, storage: { from: () => ({ download: async () => ({ data: new Blob([Buffer.from('fakepng')]) }) }) } };
}
const uc = (role, sb) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async () => ({ data: role }), ...(sb ? { from: sb.from, storage: sb.storage } : {}) });
const POLS = [
  { coverage: 'auto_liability', insurer: 'Example Insurance Agency', policy_number: 'TEST-AL-0001', limit_amount: 1000000, effective_date: '2026-01-01', expiry_date: '2026-11-01' },
  { coverage: 'cargo', insurer: 'Example Insurance Agency', policy_number: 'TEST-CG-0002', limit_amount: 100000, effective_date: '2026-01-01', expiry_date: '2026-11-01' },
  { coverage: 'general_liability', insurer: 'Example Insurance Agency', policy_number: 'TEST-GL-0003', limit_amount: 1000000, effective_date: '2026-01-01', expiry_date: '2026-11-01' },
];
const slowAi = (pols = POLS) => async () => { await new Promise((r) => setTimeout(r, 20)); return { data: { policies: pols } }; };
const suggest = (sb, ai = slowAi(), role = 'owner') => SUG.POST(new Request('http://x/api/company/insurance/suggest', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ documentId: DOC }) }), { deps: { mkUserClient: uc(role, sb), env: { OPENAI_API_KEY: 'fake' }, runExtraction: ai } });
const docSeed = () => ({ documents: [{ id: DOC, user_id: 'owner1', file_path: 'owner1/fake-coi.jpg', doc_type: 'coi' }] });

// (1) duplicates
test('planSuggestions: key = coverage + policy number (else insurer); confirmed never touched; same-doc unconfirmed updated', () => {
  assert.equal(policyKey({ coverage: 'cargo', policy_number: 'TEST-CG 0002' }), policyKey({ coverage: 'cargo', policy_number: 'test-cg-0002', insurer: 'X' }));
  assert.notEqual(policyKey({ coverage: 'cargo', insurer: 'A' }), policyKey({ coverage: 'cargo', insurer: 'B' }));
  const existing = [
    { id: 'c1', coverage: 'auto_liability', policy_number: 'TEST-AL-0001', confirmed: true, document_id: null },
    { id: 'u1', coverage: 'cargo', policy_number: 'TEST-CG-0002', limit_amount: 50000, confirmed: false, document_id: DOC },
    { id: 'u2', coverage: 'general_liability', policy_number: 'TEST-GL-0003', confirmed: false, document_id: DOC2 },
  ];
  const p = planSuggestions([...POLS, POLS[2]], existing, DOC);
  assert.deepEqual(p.update, [{ id: 'u1', patch: { insurer: 'Example Insurance Agency', limit_amount: 100000, effective_date: '2026-01-01', expiry_date: '2026-11-01' } }]);
  assert.deepEqual(p.insert.map((r) => r.coverage), ['general_liability']); // other doc's unconfirmed row isn't reused
  assert.equal(p.skipped, 2); // confirmed auto + repeated GL in same reading
  assert.deepEqual(duplicateSuggestionIds([{ id: 'b', document_id: DOC, coverage: 'cargo', policy_number: 'X', created_at: '2' }, { id: 'a', document_id: DOC, coverage: 'cargo', policy_number: 'X', created_at: '1' }, { id: 'c', document_id: DOC, coverage: 'cargo', policy_number: 'X', created_at: '3', confirmed: true }], DOC), ['b']);
});

test('Suggest route: re-run is idempotent (3 rows, not 6) and never changes confirmed rows', async () => {
  const sb = fakeSb(docSeed());
  const j1 = await (await suggest(sb)).json();
  assert.equal(j1.added, 3); assert.equal(sb.tbl.insurance_policies.length, 3); assert.equal(j1.policies.length, 3);
  const cargo = sb.tbl.insurance_policies.find((r) => r.coverage === 'cargo'); cargo.confirmed = true; cargo.limit_amount = 123;
  const j2 = await (await suggest(sb, slowAi(POLS.map((p) => ({ ...p, limit_amount: (p.limit_amount || 0) + 1 }))))).json();
  assert.equal(sb.tbl.insurance_policies.length, 3); assert.equal(j2.added, 0); assert.equal(j2.updated, 2); assert.equal(j2.skipped, 1);
  assert.equal(cargo.limit_amount, 123); assert.equal(cargo.confirmed, true);
});

test('Suggest route: two simultaneous calls converge to one row per policy (no DB index needed)', async () => {
  const sb = fakeSb(docSeed());
  await Promise.all([suggest(sb), suggest(sb)]);
  assert.equal(sb.tbl.insurance_policies.length, 3);
  assert.deepEqual(sb.tbl.insurance_policies.map((r) => r.coverage).sort(), ['auto_liability', 'cargo', 'general_liability']);
});

test('client: in-flight guard + disabled while reading + list refreshed in place from the response', () => {
  const ui = read('../../app/company/CompanyInsurance.js');
  assert.match(ui, /const inFlight = useRef\(false\)/); assert.match(ui, /if \(inFlight\.current\) return null;/);
  assert.match(ui, /disabled=\{busy\} aria-busy=\{reading === d\.id\}/); assert.match(ui, /'Reading COI…'/);
  assert.match(ui, /setSt\(\(x\) => \(\{ \.\.\.x, policies: r\.policies \}\)\)/);
  assert.equal(suggestMessage({ found: 3, added: 0, updated: 0, skipped: 3 }), '3 already on file.');
  assert.equal(suggestMessage({ found: 3, added: 3, updated: 0, skipped: 0 }), '3 suggested policies added. Check and confirm each one.');
});

// (3) /company gap note
test('/company shows "needs your confirmation" (and coverage gaps) while unconfirmed rows exist', () => {
  const g = companyGapNotes(coiGaps({ policies: [{ coverage: 'auto_liability', limit_amount: 1e6, expiry_date: '2099-01-01', confirmed: true }, { coverage: 'cargo', limit_amount: 1e5, confirmed: false }], certHolder: null }));
  assert.deepEqual(g.map((x) => x.code), ['missing', 'unconfirmed']); assert.match(g[1].text, /needs your confirmation/);
  assert.match(read('../../app/company/CompanyInsurance.js'), /data-testid="company-gaps"/);
});

// (4) change type
test('Change type route: owner/management only, validates type, never extracts, offers read only for rate con', async () => {
  const run = async (role, docType) => { const sb = fakeSb({ documents: [{ id: DOC, user_id: 'owner1', doc_type: 'rate_confirmation' }] });
    const r = await TYPE.PATCH(new Request(`http://x/api/documents/${DOC}/type`, { method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ docType }) }), { params: { id: DOC }, deps: { sb, mkUserClient: uc(role) } });
    return { status: r.status, j: await r.json(), doc: sb.tbl.documents[0] }; };
  assert.equal((await run('driver', 'coi')).status, 403); assert.equal((await run('dispatcher', 'coi')).status, 403); assert.equal((await run(null, 'coi')).status, 404);
  assert.equal((await run('owner', 'bogus')).status, 422);
  const ok = await run('management', 'coi'); assert.equal(ok.status, 200); assert.equal(ok.doc.doc_type, 'coi'); assert.equal(ok.j.offerRead, false);
  const sb = fakeSb({ documents: [{ id: DOC, user_id: 'owner1', doc_type: 'coi' }] });
  const back = await (await TYPE.PATCH(new Request(`http://x/api/documents/${DOC}/type`, { method: 'PATCH', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ docType: 'rate_confirmation' }) }), { params: { id: DOC }, deps: { sb, mkUserClient: uc('owner') } })).json();
  assert.equal(back.offerRead, true);
  const src = read('../../app/api/documents/[id]/type/route.js'); assert.doesNotMatch(src, /import [^\n]*extract|runExtraction|api\.openai|\/api\/extract/i);
  assert.equal(canChangeDocType('owner'), true); assert.equal(canChangeDocType('management'), true); assert.equal(canChangeDocType('dispatcher'), false); assert.equal(canChangeDocType('driver'), false);
  const page = read('../../app/documents/page.js');
  assert.match(page, /data-testid="change-type"/); assert.match(page, /typeChanged\[d\.id\] \? 'Read as rate con'/);
  assert.doesNotMatch(page.slice(page.indexOf('async function changeType'), page.indexOf('async function changeType') + 1500), /extract\(/);
});

// (5) holder name + address in body, prefilled from the packet's last request
test('COI body has holder name AND address; GET prefills holder address from the last request', async () => {
  const b = defaultCoiDraft({ profile: { legal_name: 'T (FAKE)' }, certHolder: { name: 'Test Broker LLC (FAKE)', address: '1 Fake St, Testville, CA 90000' } }).body;
  assert.match(b, /Certificate holder:\nTest Broker LLC \(FAKE\)\n1 Fake St, Testville, CA 90000/);
  const sb = fakeSb({ packets: [{ id: PID, owner_id: 'owner1', broker_name: 'Old Name' }], coi_requests: [{ id: 'r1', packet_id: PID, cert_holder_name: 'Test Broker LLC (FAKE)', cert_holder_address: '1 Fake St', sent_at: '2026-10-17T00:00:00Z' }] });
  const g = await (await COI.GET(new Request(`http://x/api/packets/${PID}/coi-request`, { headers: { authorization: 'Bearer t' } }), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env: {} } })).json();
  assert.deepEqual(g.certHolder, { name: 'Test Broker LLC (FAKE)', address: '1 Fake St' });
  assert.match(g.draft.body, /Test Broker LLC \(FAKE\)\n1 Fake St/);
  assert.match(read('../../app/packets/PacketCoiRequest.js'), /holderAddress: x\.holderAddress \|\| j\.certHolder\?\.address/);
});

// (7) cap reached label + grey disabled Send now in both review steps
test('cap reached → "Monthly limit reached"; Send now uses #65 disabled style in COI and broker reviews', () => {
  assert.equal(capLabel({ used: 1, cap: 0 }), 'Monthly limit reached'); assert.equal(capLabel({ used: 80, cap: 80 }), 'Monthly limit reached'); assert.equal(capLabel({ used: 3, cap: 80 }), '3 of 80 used this month');
  for (const f of ['PacketCoiRequest.js', 'PacketSendBroker.js']) {
    const s = read(`../../app/packets/${f}`);
    assert.match(s, /primaryButtonStyle\(\{ \.\.\.primary, flex: 2, background: '#059669' \}, !ok \|\| busy \|\| capFull( \|\| !size\.ok)?\)\} disabled=\{!ok \|\| busy \|\| capFull( \|\| !size\.ok)?\}/, f); // PR #84 adds the attachment size cap on the broker send
    assert.match(s, /'Monthly limit reached\. Nothing more can be sent this month\.'/, f);
    assert.doesNotMatch(s, /opacity: ok && !busy/, f);
  }
});

// (8) Upload COI is a real link with no handler. PR #84: it jumps to the vault's COI row on the same page.
test('Upload COI is a plain link to the vault COI row (#vault-coi) with no onClick', () => {
  const ui = read('../../app/company/CompanyInsurance.js');
  const tag = ui.slice(ui.indexOf('<a href="#vault-coi"'), ui.indexOf('>Upload COI</a>'));
  assert.ok(tag.length > 0); assert.doesNotMatch(tag, /onClick/);
});

test('migrations: 20261017001800 unchanged (already on prod); new optional 20261017001900 unique index is additive', () => {
  const m18 = read('../../supabase/migrations/20261017001800_insurance_coi.sql');
  assert.match(m18, /NOT applied anywhere yet/); // original header kept verbatim
  const m19 = read('../../supabase/migrations/20261017002000_insurance_policy_suggest_unique.sql');
  assert.match(m19, /create unique index if not exists insurance_policies_ai_suggest_unique/);
  assert.match(m19, /where source = 'ai' and confirmed = false/);
  assert.doesNotMatch(m19, /\bdrop\b|\bdelete\b|\btruncate\b|alter\s+table/i);
});
