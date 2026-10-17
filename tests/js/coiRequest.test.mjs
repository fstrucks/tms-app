import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthlyCap, monthStartISO, monthlyUsage, capReached, capLabel, DEFAULT_MONTHLY_CAP } from '../../app/lib/sendCap.js';
import { coiGaps, minimumsFrom, DEFAULT_MINIMUMS } from '../../app/lib/coiGaps.js';
import { defaultCoiDraft, validateCoiRequest, validateAgent, validatePolicy, suggestionsToPolicies, coiEnabled } from '../../app/lib/coiRequest.js';
import { inputPart, DOC_TYPES } from '../../app/lib/ai-extract.js';
import * as SEND from '../../app/api/packets/[id]/send/route.js';
import * as COI from '../../app/api/packets/[id]/coi-request/route.js';
import * as INS from '../../app/api/company/insurance/route.js';
import * as POL from '../../app/api/company/insurance/policies/route.js';
import * as SUG from '../../app/api/company/insurance/suggest/route.js';

const PID = '00000000-0000-4000-8000-0000000000c1';
const ENV = { POSTMARK_SERVER_TOKEN: 'fake-token-for-tests', NEXT_PUBLIC_COI_REQUEST_ENABLED: '1' };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Minimal chainable fake Supabase (FAKE data only).
function fakeSb(seed = {}, { missing = [] } = {}) {
  const tbl = { packets: [], packet_sends: [], coi_requests: [], company_profiles: [], insurance_agents: [], insurance_policies: [], documents: [], ...seed };
  let n = 0;
  const from = (name) => {
    const st = { op: 'select', f: [], g: null };
    const run = () => {
      if (missing.includes(name)) return { data: null, count: null, error: { code: '42P01', message: `relation "${name}" does not exist` } };
      tbl[name] ||= [];
      if (st.op === 'insert') {
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        if (list.some((p) => p.id && tbl[name].some((r) => r.id === p.id))) return { error: { code: '23505', message: 'duplicate key' } };
        const added = list.map((p) => ({ id: p.id || `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, sent_at: new Date().toISOString(), ...p }));
        tbl[name].push(...added); return { data: Array.isArray(st.payload) ? added : added[0], error: null };
      }
      if (st.op === 'upsert') { const i = tbl[name].findIndex((r) => r.owner_id === st.payload.owner_id); if (i >= 0) Object.assign(tbl[name][i], st.payload); else tbl[name].push({ id: 'ag' + (++n), ...st.payload }); return { error: null }; }
      const rows = tbl[name].filter((r) => st.f.every(([k, v]) => r[k] === v) && (!st.g || String(r[st.g[0]]) >= st.g[1]));
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: st.one ? rows[0] || null : rows, error: null }; }
      if (st.op === 'delete') { tbl[name] = tbl[name].filter((r) => !rows.includes(r)); return { error: null }; }
      return { data: st.one ? rows[0] || null : rows, count: rows.length, error: null };
    };
    const b = { select() { return b; }, eq(k, v) { st.f.push([k, v]); return b; }, gte(k, v) { st.g = [k, v]; return b; }, order() { return b; }, limit() { return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; }, delete() { st.op = 'delete'; return b; }, insert(p) { st.op = 'insert'; st.payload = p; return b; }, upsert(p) { st.op = 'upsert'; st.payload = p; return b; },
      maybeSingle: async () => { st.one = true; return run(); }, then: (res, rej) => Promise.resolve().then(run).then(res, rej) };
    return b;
  };
  return { from, tbl, storage: { from: () => ({ download: async (p) => (p === 'owner1/coi.png' ? { data: new Blob([Buffer.from('fakepng')]) } : { data: null }) }) } };
}
const uc = (role, sb) => () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u-' + role } } }) }, rpc: async () => ({ data: role }), ...(sb ? { from: sb.from, storage: sb.storage } : {}) });
const req = (body, method = 'POST', path = `/api/packets/${PID}/coi-request`) => new Request(`http://x${path}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const mockFetch = () => { const calls = []; const f = async (u, o) => { calls.push({ u, b: JSON.parse(o.body) }); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-fake-1' }), { status: 200 }); }; f.calls = calls; return f; };
const pkt = { id: PID, owner_id: 'owner1', status: 'review', broker_name: 'Test Broker LLC (FAKE)', original_filename: 'Setup (FAKE).pdf', filled_path: 'owner1/packets/filled/x.pdf' };
const KEY = '11111111-1111-4111-8111-111111111111';
const OK = { to: 'agent-test@fstrucks.com', cc: '', subject: 'COI request (FAKE)', body: 'Please send a COI (FAKE)', certHolder: { name: 'Test Broker LLC (FAKE)', address: '1 Fake St, Testville CA' }, loadDate: '2026-10-20', confirm: true, idempotencyKey: KEY };
const thisMonth = () => new Date().toISOString();

// ---------- monthly cap ----------
test('cap: default 80, EMAIL_MONTHLY_CAP override, bad values fall back', () => {
  assert.equal(DEFAULT_MONTHLY_CAP, 80);
  assert.equal(monthlyCap({}), 80); assert.equal(monthlyCap({ EMAIL_MONTHLY_CAP: '25' }), 25); assert.equal(monthlyCap({ EMAIL_MONTHLY_CAP: '0' }), 0);
  assert.equal(monthlyCap({ EMAIL_MONTHLY_CAP: 'lots' }), 80); assert.equal(monthlyCap({ EMAIL_MONTHLY_CAP: '-3' }), 80);
});

test('cap: calendar month starts at LA midnight (PDT and PST)', () => {
  assert.equal(monthStartISO(new Date('2026-10-17T15:00:00Z')), '2026-10-01T07:00:00.000Z');
  assert.equal(monthStartISO(new Date('2026-12-05T12:00:00Z')), '2026-12-01T08:00:00.000Z');
  assert.equal(monthStartISO(new Date('2026-11-01T06:30:00Z')), '2026-10-01T07:00:00.000Z'); // still Oct 31 in LA
});

test('cap: counts packet_sends + coi_requests this month only; missing coi table counts 0', async () => {
  const old = '2026-01-15T12:00:00.000Z';
  const sb = fakeSb({ packet_sends: [{ id: 'a', sent_at: thisMonth() }, { id: 'b', sent_at: old }], coi_requests: [{ id: 'c', sent_at: thisMonth() }, { id: 'd', sent_at: thisMonth(), postmark_message_id: null }] });
  const u = await monthlyUsage(sb, { EMAIL_MONTHLY_CAP: '3' });
  assert.equal(u.used, 3); assert.equal(u.cap, 3); assert.equal(capReached(u), true); assert.equal(capLabel(u), 'Monthly limit reached'); assert.equal(capLabel({ used: 2, cap: 3 }), '2 of 3 used this month');
  const u2 = await monthlyUsage(fakeSb({ packet_sends: [{ id: 'a', sent_at: thisMonth() }] }, { missing: ['coi_requests'] }), {});
  assert.equal(u2.used, 1); assert.equal(capReached(u2), false);
});

test('#64 send route: refuses at the cap (429) WITHOUT calling Postmark; GET shows usage', async () => {
  const full = Array.from({ length: 2 }, (_, i) => ({ id: 'x' + i, sent_at: thisMonth() }));
  const sb = fakeSb({ packets: [{ ...pkt }], coi_requests: full, company_profiles: [{ owner_id: 'owner1', legal_name: 'Test Co (FAKE)' }] });
  const f = mockFetch();
  const r = await SEND.POST(req({ to: 'dispatch@fstrucks.com', subject: 'S (FAKE)', body: 'B', confirm: true }, 'POST', `/api/packets/${PID}/send`), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env: { ...ENV, EMAIL_MONTHLY_CAP: '2' }, fetch: f } });
  assert.equal(r.status, 429); const j = await r.json(); assert.equal(j.capReached, true); assert.match(j.error, /2 of 2/); assert.match(j.error, /Nothing was sent/);
  assert.equal(f.calls.length, 0); assert.equal(sb.tbl.packet_sends.length, 0);
  const g = await (await SEND.GET(req(null, 'GET', `/api/packets/${PID}/send`), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env: { ...ENV, EMAIL_MONTHLY_CAP: '2' } } })).json();
  assert.deepEqual(g.sendCap, { used: 2, cap: 2, remaining: 0 });
});

// ---------- gaps ----------
const P = (o) => ({ confirmed: true, coverage: 'auto_liability', limit_amount: 1000000, effective_date: '2026-01-01', expiry_date: '2027-01-01', ...o });
test('gaps: all good → none', () => {
  assert.deepEqual(coiGaps({ policies: [P(), P({ coverage: 'cargo', limit_amount: 100000 })], loadDate: '2026-10-20', certHolder: { name: 'B (FAKE)', address: '1 St' } }), []);
});
test('gaps: missing, below min, expired before load date, cert holder, unconfirmed', () => {
  const codes = (o) => coiGaps(o).map((g) => g.code).sort();
  assert.deepEqual(codes({ policies: [], certHolder: { name: 'B', address: 'x' } }), ['missing', 'missing']);
  assert.deepEqual(codes({ policies: [P({ limit_amount: 750000 }), P({ coverage: 'cargo', limit_amount: 100000 })], certHolder: { name: 'B', address: 'x' } }), ['below_min']);
  const exp = coiGaps({ policies: [P({ expiry_date: '2026-10-15' }), P({ coverage: 'cargo', limit_amount: 250000 })], loadDate: '2026-10-20', certHolder: { name: 'B', address: 'x' } });
  assert.deepEqual(exp.map((g) => g.code), ['expired']); assert.match(exp[0].text, /2026-10-15.*load date/);
  assert.deepEqual(codes({ policies: [P(), P({ coverage: 'cargo', limit_amount: 1e5 })], certHolder: null }), ['cert_holder_missing']);
  assert.deepEqual(codes({ policies: [P(), P({ coverage: 'cargo', limit_amount: 1e5 })], certHolder: { name: 'B' } }), ['cert_holder_address_missing']);
  // Unconfirmed AI row doesn't satisfy cargo.
  assert.deepEqual(codes({ policies: [P(), P({ coverage: 'cargo', limit_amount: 1e5, confirmed: false })], certHolder: { name: 'B', address: 'x' } }), ['missing', 'unconfirmed']);
});
test('gaps: configurable minimums; defaults $1M / $100k', () => {
  assert.deepEqual(DEFAULT_MINIMUMS, { auto_liability: 1000000, cargo: 100000 });
  assert.deepEqual(minimumsFrom(null), DEFAULT_MINIMUMS);
  const g = coiGaps({ policies: [P(), P({ coverage: 'cargo', limit_amount: 100000 })], profile: { min_auto_liability: 2000000, min_cargo: 250000 }, certHolder: { name: 'B', address: 'x' } });
  assert.deepEqual(g.map((x) => x.coverage), ['auto_liability', 'cargo']);
});

// ---------- helpers ----------
test('draft, request validation (fstrucks.com only), agent/policy validation, AI suggestions stay unconfirmed', () => {
  const d = defaultCoiDraft({ packet: pkt, profile: { legal_name: 'Test Co (FAKE)', mc_number: '000000' }, agent: { name: 'Pat Agent' }, certHolder: { name: 'Test Broker LLC (FAKE)', address: '1 Fake St' }, loadDate: '2026-10-20' });
  assert.match(d.subject, /COI request – Test Co \(FAKE\)/); assert.match(d.body, /Hi Pat,/); assert.match(d.body, /Test Broker LLC \(FAKE\)\n1 Fake St/); assert.match(d.body, /\$1,000,000/); assert.match(d.body, /2026-10-20/);
  assert.equal(validateCoiRequest({ ...OK, to: 'agent@insurer.example' }, {}).status, 403);
  assert.equal(validateCoiRequest({ ...OK, certHolder: { name: '' } }, {}).status, 422);
  assert.equal(validateCoiRequest({ ...OK, loadDate: '10/20/2026' }, {}).status, 422);
  assert.equal(validateCoiRequest({ ...OK, confirm: false }, {}).status, 400);
  assert.equal(validateCoiRequest(OK, {}).certHolder.name, 'Test Broker LLC (FAKE)');
  assert.deepEqual(validateAgent({ email: 'nope' }).errors, { email: 'Enter a valid email.' });
  assert.equal(validateAgent({ email: 'Pat@FSTRUCKS.com ' }).agent.email, 'pat@fstrucks.com');
  assert.equal(validatePolicy({ coverage: 'cargo', limit_amount: '$100,000' }).row.limit_amount, 100000);
  assert.ok(validatePolicy({ coverage: 'cargo', effective_date: '2026-05-01', expiry_date: '2026-01-01' }).errors.expiry_date);
  assert.ok(validatePolicy({ coverage: 'boats' }).errors.coverage);
  const s = suggestionsToPolicies({ policies: [{ coverage: 'cargo', insurer: 'Fake Mutual', policy_number: 'C-1', limit_amount: 100000, effective_date: '2026-01-01', expiry_date: '2027-01-01' }, { coverage: 'nope' }] }, '00000000-0000-4000-8000-0000000000d1');
  assert.equal(s.length, 1); assert.equal(s[0].confirmed, false); assert.equal(s[0].source, 'ai'); assert.equal(s[0].document_id, '00000000-0000-4000-8000-0000000000d1');
  assert.equal(coiEnabled({}), false); assert.equal(coiEnabled({ NEXT_PUBLIC_COI_REQUEST_ENABLED: '1' }), true); assert.equal(coiEnabled({ NEXT_PUBLIC_COI_REQUEST_ENABLED: 'yes' }), false);
  assert.equal(inputPart('data:application/pdf;base64,AA').type, 'input_file'); assert.equal(inputPart('data:image/png;base64,AA').type, 'input_image');
  assert.ok(DOC_TYPES.coi && DOC_TYPES.receipt);
});

// ---------- COI request route ----------
const coiSb = (o = {}) => fakeSb({ packets: [{ ...pkt }], company_profiles: [{ owner_id: 'owner1', legal_name: 'Test Co (FAKE)' }], insurance_agents: [{ owner_id: 'owner1', name: 'Pat Agent (FAKE)', email: 'agent-test@fstrucks.com' }], ...o.seed }, o);
const post = (sb, role, body, env = ENV, f = mockFetch()) => COI.POST(req(body), { params: { id: PID }, deps: { sb, mkUserClient: uc(role), env, fetch: f } });

test('COI route: flag off, role, confirm, allowlist, no token, missing table, cap all refuse WITHOUT calling Postmark', async () => {
  const f = mockFetch();
  const st = async (role, body, o = {}) => (await post(o.sb || coiSb(), role, body, o.env || ENV, f)).status;
  assert.equal(await st('owner', OK, { env: { POSTMARK_SERVER_TOKEN: 'fake' } }), 403); // feature flag off
  assert.equal(await st('dispatcher', OK), 403);
  assert.equal(await st('driver', OK), 403);
  assert.equal(await st('owner', { ...OK, confirm: false }), 400);
  assert.equal(await st('owner', { ...OK, to: 'agent@insurer.example' }), 403);
  assert.equal(await st('owner', OK, { env: { NEXT_PUBLIC_COI_REQUEST_ENABLED: '1' } }), 503);
  assert.equal(await st('owner', OK, { sb: coiSb({ missing: ['coi_requests'] }) }), 503);
  assert.equal(await st('owner', OK, { sb: coiSb({ seed: { packet_sends: [{ id: 'p1', sent_at: thisMonth() }] } }), env: { ...ENV, EMAIL_MONTHLY_CAP: '1' } }), 429);
  assert.equal(f.calls.length, 0);
});

test('COI route: management sends via MOCK Postmark (no attachment), logs, duplicate key never resends, resend gate', async () => {
  const sb = coiSb(); const f = mockFetch();
  const r = await post(sb, 'management', OK, ENV, f);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].u, 'https://api.postmarkapp.com/email'); assert.equal(f.calls[0].b.Attachments, undefined);
  assert.equal(f.calls[0].b.To, 'agent-test@fstrucks.com');
  const log = sb.tbl.coi_requests[0];
  assert.equal(log.id, KEY); assert.equal(log.postmark_message_id, 'pm-fake-1'); assert.equal(log.cert_holder_name, 'Test Broker LLC (FAKE)'); assert.equal(log.load_date, '2026-10-20'); assert.equal(log.sent_by, 'u-management');
  assert.deepEqual(j.sendCap, { used: 1, cap: 80, remaining: 79 });
  const again = await (await post(sb, 'owner', OK, ENV, f)).json();
  assert.equal(again.duplicate, true); assert.equal(f.calls.length, 1);
  const r2 = await post(sb, 'owner', { ...OK, idempotencyKey: '22222222-2222-4222-8222-222222222222' }, ENV, f);
  assert.equal(r2.status, 409); assert.equal((await r2.json()).alreadySent, true); assert.equal(f.calls.length, 1);
});

test('COI route: Postmark refusal releases the claim; GET shows agent, gaps inputs, draft, cap', async () => {
  const sb = coiSb();
  const bad = async () => new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid (FAKE)' }), { status: 422 });
  const r = await COI.POST(req(OK), { params: { id: PID }, deps: { sb, mkUserClient: uc('owner'), env: ENV, fetch: bad } });
  assert.equal(r.status, 502); assert.equal(sb.tbl.coi_requests.length, 0);
  const g = await (await COI.GET(req(null, 'GET'), { params: { id: PID }, deps: { sb, mkUserClient: uc('driver'), env: ENV } })).json();
  assert.equal(g.enabled, true); assert.equal(g.canSend, false); assert.equal(g.agent.email, 'agent-test@fstrucks.com');
  assert.deepEqual(g.minimums, { auto_liability: 1000000, cargo: 100000 }); assert.equal(g.certHolder.name, 'Test Broker LLC (FAKE)');
  assert.match(g.draft.body, /Hi Pat/); assert.deepEqual(g.sendCap, { used: 0, cap: 80, remaining: 80 }); assert.deepEqual(g.allowedDomains, ['fstrucks.com']);
});

// ---------- insurance routes ----------
const insReq = (body, method, path) => req(body, method, path);
test('insurance: drivers/dispatchers read only; owner saves agent + minimums; manual policy confirmed', async () => {
  const sb = fakeSb({ company_profiles: [{ id: 'cp1', owner_id: 'owner1', legal_name: 'Test Co (FAKE)' }] });
  const deps = (role) => ({ deps: { mkUserClient: uc(role, sb) } });
  const g = await (await INS.GET(insReq(null, 'GET', '/api/company/insurance'), deps('driver'))).json();
  assert.equal(g.canEdit, false); assert.deepEqual(g.minimums, { auto_liability: 1000000, cargo: 100000 });
  assert.equal((await INS.PUT(insReq({ agent: { name: 'X' } }, 'PUT', '/api/company/insurance'), deps('dispatcher'))).status, 403);
  assert.equal((await INS.PUT(insReq({ agent: { email: 'bad' } }, 'PUT', '/api/company/insurance'), deps('owner'))).status, 422);
  const p = await (await INS.PUT(insReq({ agent: { name: 'Pat Agent (FAKE)', agency: 'Fake Agency', email: 'agent-test@fstrucks.com', phone: '555-010-0000' }, minimums: { auto_liability: '1,500,000', cargo: '150000' } }, 'PUT', '/api/company/insurance'), deps('management'))).json();
  assert.equal(p.agent.email, 'agent-test@fstrucks.com'); assert.deepEqual(p.minimums, { auto_liability: 1500000, cargo: 150000 });
  assert.equal(sb.tbl.insurance_agents.length, 1);
  await INS.PUT(insReq({ agent: { name: 'Pat 2 (FAKE)' } }, 'PUT', '/api/company/insurance'), deps('owner'));
  assert.equal(sb.tbl.insurance_agents.length, 1); // one agent per company
  const pol = await (await POL.POST(insReq({ coverage: 'cargo', limit_amount: '100000', expiry_date: '2027-01-01' }, 'POST', '/api/company/insurance/policies'), deps('owner'))).json();
  assert.equal(pol.policy.confirmed, true); assert.equal(pol.policy.source, 'manual');
  assert.equal((await POL.POST(insReq({ coverage: 'cargo' }, 'POST', '/api/company/insurance/policies'), deps('driver'))).status, 403);
});

test('insurance suggest: AI rows saved unconfirmed (fake reader), confirm flips them; missing key → 501', async () => {
  const DOC = '00000000-0000-4000-8000-0000000000d2';
  const sb = fakeSb({ company_profiles: [{ id: 'cp1', owner_id: 'owner1' }], documents: [{ id: DOC, file_path: 'owner1/coi.png', doc_type: 'coi' }] });
  const reader = async (type, o) => { assert.equal(type, 'coi'); assert.match(o.dataUrl, /^data:image\/png;base64,/); return { data: { policies: [{ coverage: 'auto_liability', insurer: 'Fake Mutual', policy_number: 'A-1', limit_amount: 1000000, effective_date: '2026-01-01', expiry_date: '2027-01-01' }] } }; };
  const d = { deps: { mkUserClient: uc('owner', sb), env: { OPENAI_API_KEY: 'fake' }, runExtraction: reader } };
  const r = await (await SUG.POST(insReq({ documentId: DOC }, 'POST', '/api/company/insurance/suggest'), d)).json();
  assert.equal(r.policies.length, 1); assert.equal(r.policies[0].confirmed, false); assert.equal(r.policies[0].source, 'ai');
  const id = r.policies[0].id;
  const c = await (await POL.PATCH(insReq({ id, confirm: true }, 'PATCH', '/api/company/insurance/policies'), d)).json();
  assert.equal(c.policy.confirmed, true); assert.equal(c.policy.confirmed_by, 'u-owner');
  assert.equal((await SUG.POST(insReq({ documentId: DOC }, 'POST', '/api/company/insurance/suggest'), { deps: { mkUserClient: uc('owner', sb), env: {} } })).status, 501);
});

// ---------- migration + wiring ----------
test('migration 20261017001800 is additive with RLS (packet_role reads, owner/management writes, coi_requests read-only)', () => {
  const m = read('../../supabase/migrations/20261017001800_insurance_coi.sql');
  assert.doesNotMatch(m, /\bdrop\s+(table|column)\b|\btruncate\b|\bdelete\s+from\b|alter\s+column/i);
  for (const t of ['insurance_agents', 'insurance_policies', 'coi_requests']) { assert.match(m, new RegExp(`create table if not exists public\\.${t}`)); assert.match(m, new RegExp(`alter table public\\.${t} enable row level security`)); }
  assert.match(m, /insurance_agents_owner_unique unique \(owner_id\)/);
  assert.match(m, /min_auto_liability numeric not null default 1000000/); assert.match(m, /min_cargo numeric not null default 100000/);
  assert.equal((m.match(/packet_role\(owner_id\) in \('owner', 'management'\)/g) || []).length, 4);
  assert.match(m, /confirmed boolean not null default false/);
  assert.doesNotMatch(m, /coi_requests_(insert|update|delete|write)/);
});

test('flag-gated UI + cap shown in both review steps', () => {
  const page = read('../../app/packets/[id]/page.js');
  assert.match(page, /\{COI_FLAG && <PacketCoiRequest/);
  const coi = read('../../app/packets/PacketCoiRequest.js');
  assert.match(coi, /NEXT_PUBLIC_COI_REQUEST_ENABLED/); assert.match(coi, /if \(!enabled \|\| !info\) return null/);
  assert.match(coi, /capLabel\(info\.sendCap\)/); assert.match(coi, /outsideRecipients\(/); assert.match(coi, /primaryButtonStyle\(\{ \.\.\.primary, flex: 2 \}, outside\.length > 0\)/);
  assert.match(page, /paddingBottom: sendWrapPadding\(barShown\)/); assert.match(page, /coiStep === 'review'\} onBarShownChange=\{setBarShown\}/); assert.match(coi, /disabled=\{!ok \|\| busy \|\| capFull\}/);
  assert.match(read('../../app/packets/PacketSendBroker.js'), /capLabel\(info\.sendCap\)/);
  assert.match(read('../../app/company/page.js'), /<CompanyInsurance \/>/);
  const env = read('../../.env.example');
  assert.match(env, /EMAIL_MONTHLY_CAP=80/); assert.match(env, /NEXT_PUBLIC_COI_REQUEST_ENABLED=0/);
});
