// PR #110: scale tickets and BOLs show under their load. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { suggestLoad, loadForSuggest, canViewLoadDocs, visibleDocsFor, canLinkDoc, isLoadDocType, isImagePath } from '../../app/lib/loadDocs.js';
import { classifyDocText, decideDocKind } from '../../app/lib/docClassify.js';
import { DOC_TYPES } from '../../app/lib/ai-extract.js';
import { LOAD_SCAN_TYPE_IDS, UPLOAD_TYPES } from '../../app/lib/docTypes.js';
import * as LINK from '../../app/api/documents/[id]/load/route.js';
import * as LIST from '../../app/api/loads/[id]/documents/route.js';
import * as SUGGEST from '../../app/api/documents/[id]/suggest-load/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', DRIVER2 = '00000000-0000-4000-8000-0000000000a3', MGMT = '00000000-0000-4000-8000-0000000000a4', OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1', L2 = '00000000-0000-4000-8000-0000000000b2', XL = '00000000-0000-4000-8000-0000000000b9';
const DOC_DRV = '00000000-0000-4000-8000-0000000000c1', DOC_OWN = '00000000-0000-4000-8000-0000000000c2', DOC_RC = '00000000-0000-4000-8000-0000000000c3', DOC_X = '00000000-0000-4000-8000-0000000000c9', DOC_ST = '00000000-0000-4000-8000-0000000000c4';

test('types: scale ticket + BOL are load paperwork, offered by the load-page scanner and the Upload type picker', () => {
  for (const t of ['bol', 'scale_ticket', 'pod', 'lumper_receipt', 'other:Gate pass']) assert.ok(isLoadDocType(t), t);
  for (const t of ['coi', 'w9', 'rate_confirmation', 'receipt', null]) assert.ok(!isLoadDocType(t), String(t));
  assert.ok(LOAD_SCAN_TYPE_IDS.includes('scale_ticket') && LOAD_SCAN_TYPE_IDS.includes('bol'));
  assert.ok(UPLOAD_TYPES.some((t) => t.id === 'scale_ticket') && UPLOAD_TYPES.some((t) => t.id === 'bol'));
  assert.ok(isImagePath('u/1-a.JPG') && !isImagePath('u/1-a.pdf'));
});

test('classifier: BOL and CAT scale text are recognized; rate cons and COIs unchanged', () => {
  assert.equal(classifyDocText('STRAIGHT BILL OF LADING  Shipper signature  NMFC  Class 70  Pallets 22  Consignee'), 'bol');
  assert.equal(classifyDocText('CAT SCALE  Certified scale  STEER AXLE 11,840  DRIVE AXLE 33,920  TRAILER AXLE 33,100  GROSS 78,860  Weighmaster'), 'scale_ticket');
  assert.equal(classifyDocText('RATE CONFIRMATION  Carrier pay  Line haul  Shipper  Consignee  Pick up  Delivery'), 'rate_confirmation');
  assert.equal(classifyDocText('CERTIFICATE OF LIABILITY INSURANCE ACORD 25 CERTIFICATE HOLDER INSURER A'), 'coi');
  assert.equal(decideDocKind({ aiKind: 'bol', aiText: 'BILL OF LADING' }), 'bol');
  assert.equal(decideDocKind({ aiKind: 'scale_ticket', aiText: 'CAT SCALE' }), 'scale_ticket');
  assert.equal(decideDocKind({ aiKind: 'bol', aiText: 'RATE CONFIRMATION carrier pay line haul' }), 'rate_confirmation');
  assert.equal(decideDocKind({ aiKind: 'rate_confirmation', aiText: '' }), 'rate_confirmation');
  assert.equal(DOC_TYPES.load_doc.normalize({ doc_kind: 'nope', reference_numbers: [' 123 ', ''], doc_date: '10/20/26' }).doc_kind, 'other');
  assert.deepEqual(DOC_TYPES.load_doc.normalize({ doc_kind: 'bol', reference_numbers: [' PO 7781 '], doc_date: '2026-10-20' }), { doc_kind: 'bol', reference_numbers: ['PO 7781'], doc_date: '2026-10-20' });
});

const loads = [
  loadForSuggest({ id: L1, broker_load_number: 'FAKE-5741', status: 'in_transit', assigned_driver_user_id: DRIVER, notes: 'Refs: PU# 99881, PO 4410',
    stops: [{ sequence: 1, stop_type: 'pickup', appointment_start: '2026-10-19T14:00:00Z' }, { sequence: 2, stop_type: 'delivery', appointment_start: '2026-10-21T14:00:00Z' }] }),
  loadForSuggest({ id: L2, broker_load_number: 'FAKE-6000', status: 'booked', assigned_driver_user_id: null, notes: '',
    stops: [{ sequence: 1, stop_type: 'pickup', appointment_start: '2026-10-25T14:00:00Z', pickup_number: 'A-77' }] }),
];
test('suggestLoad: number first, then driver active load, then date; null when unsure', () => {
  assert.deepEqual(suggestLoad(loads, { refs: ['fake 6000'], userId: DRIVER }), { loadId: L2, reason: 'number' });
  assert.deepEqual(suggestLoad(loads, { refs: ['99881'] }), { loadId: L1, reason: 'number' }); // "PU# 99881" in notes
  assert.deepEqual(suggestLoad(loads, { refs: ['A77'] }), { loadId: L2, reason: 'number' }); // stops.pickup_number
  assert.deepEqual(suggestLoad(loads, { refs: ['nomatch'], userId: DRIVER }), { loadId: L1, reason: 'driver_active' });
  assert.deepEqual(suggestLoad(loads, { date: '2026-10-25' }), { loadId: L2, reason: 'date' });
  assert.deepEqual(suggestLoad(loads, { date: '2026-11-30' }), { loadId: L1, reason: 'only_in_transit' }); // QA (a)
  assert.equal(suggestLoad([loads[1]], { date: '2026-11-30' }), null);
  assert.equal(suggestLoad([...loads, { ...loads[0], id: 'x2' }], {}), null); // two on the road: no guess
  assert.equal(suggestLoad([], { refs: ['x'] }), null);
});

test('access: owner/management/dispatcher see every load’s docs; drivers only assigned loads, no rate con unless rate shown', () => {
  const load = { assigned_driver_user_id: DRIVER, show_rate_to_driver: false };
  for (const r of ['owner', 'management', 'dispatcher']) assert.ok(canViewLoadDocs(r, load, MGMT));
  assert.ok(canViewLoadDocs('driver', load, DRIVER));
  assert.ok(!canViewLoadDocs('driver', load, DRIVER2));
  assert.ok(!canViewLoadDocs(null, load, DRIVER));
  const docs = [{ doc_type: 'bol' }, { doc_type: 'rate_confirmation' }];
  assert.equal(visibleDocsFor('driver', load, DRIVER, docs).length, 1);
  assert.equal(visibleDocsFor('driver', { ...load, show_rate_to_driver: true }, DRIVER, docs).length, 2);
  assert.equal(visibleDocsFor('management', load, MGMT, docs).length, 2);
  assert.ok(canLinkDoc('driver', { doc: { user_id: DRIVER }, load, userId: DRIVER }));
  assert.ok(!canLinkDoc('driver', { doc: { user_id: OWNER }, load, userId: DRIVER }));
  assert.ok(!canLinkDoc('driver', { doc: { user_id: DRIVER }, load: { assigned_driver_user_id: DRIVER2 }, userId: DRIVER }));
  assert.ok(canLinkDoc('management', { doc: { user_id: DRIVER }, load, userId: MGMT }));
});

// ---- routes (fake Supabase, no network) ----
const seed = () => ({
  loads: [{ id: L1, user_id: OWNER, broker_load_number: 'FAKE-5741', status: 'in_transit', assigned_driver_user_id: DRIVER, show_rate_to_driver: false, created_at: '2026-10-19T00:00:00Z' },
    { id: L2, user_id: OWNER, broker_load_number: 'FAKE-6000', status: 'booked', assigned_driver_user_id: DRIVER2, created_at: '2026-10-18T00:00:00Z' },
    { id: XL, user_id: OTHER, broker_load_number: 'OTHER-1', created_at: '2026-10-18T00:00:00Z' }],
  documents: [{ id: DOC_DRV, user_id: DRIVER, doc_type: 'bol', file_path: `${DRIVER}/1-bol.jpg`, original_filename: 'bol.jpg', load_id: null, created_at: '2026-10-20T00:00:00Z' },
    { id: DOC_OWN, user_id: OWNER, doc_type: 'scale_ticket', file_path: `${OWNER}/2-st.pdf`, original_filename: 'st.pdf', load_id: L1, created_at: '2026-10-20T01:00:00Z' },
    { id: DOC_RC, user_id: OWNER, doc_type: 'rate_confirmation', file_path: `${OWNER}/3-rc.pdf`, original_filename: 'rc.pdf', load_id: L1, created_at: '2026-10-19T00:00:00Z' },
    { id: DOC_ST, user_id: DRIVER, doc_type: 'scale_ticket', file_path: `${DRIVER}/4-cat.jpg`, original_filename: 'cat.jpg', load_id: null, created_at: '2026-10-20T02:00:00Z' },
    { id: DOC_X, user_id: OTHER, doc_type: 'bol', file_path: `${OTHER}/x.pdf`, original_filename: 'x.pdf', load_id: null }],
  scale_tickets: [{ id: 't1', user_id: OWNER, load_id: L1, document_id: DOC_ST }],
  company_members: [{ user_id: DRIVER, role: 'driver', 'company_profiles.owner_id': OWNER }, { user_id: DRIVER2, role: 'driver', 'company_profiles.owner_id': OWNER }, { user_id: MGMT, role: 'management', 'company_profiles.owner_id': OWNER }],
});
function ctx(role, userId) {
  const svc = fakeSupabase({ tables: seed() });
  svc.storage.from = () => ({ createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://fake.invalid/${p}` })) }) });
  const from = svc.from.bind(svc);
  svc.from = (t) => { const q = from(t); q.not = () => q; return q; }; // fake: .not() no-op (seeded tickets all have a document)
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const req = (method, body) => new Request('http://x/api', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const docOf = (svc, id) => svc.from('documents').select('*').eq('id', id).maybeSingle();

test('link route: driver links his own BOL to his assigned load; not to another driver’s load; not someone else’s doc', async () => {
  const { svc, deps } = ctx('driver', DRIVER);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L2 }), { params: { id: DOC_DRV }, deps })).status, 403);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L1 }), { params: { id: DOC_OWN }, deps })).status, 403);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L1 }), { params: { id: DOC_X }, deps })).status, 404); // other company
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: XL }), { params: { id: DOC_DRV }, deps })).status, 404);
  const r = await LINK.PATCH(req('PATCH', { loadId: L1 }), { params: { id: DOC_DRV }, deps });
  assert.equal(r.status, 200);
  assert.equal((await docOf(svc, DOC_DRV)).data.load_id, L1);
});

test('link route: management can link / change / unlink a team member’s document', async () => {
  const { svc, deps } = ctx('management', MGMT);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L2 }), { params: { id: DOC_DRV }, deps })).status, 200);
  assert.equal((await docOf(svc, DOC_DRV)).data.load_id, L2);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: null }), { params: { id: DOC_DRV }, deps })).status, 200);
  assert.equal((await docOf(svc, DOC_DRV)).data.load_id, null);
});

test('list route: load docs incl. Truck-tab scale ticket photo; driver hides rate con; other driver gets 404', async () => {
  const own = await (await LIST.GET(req('GET'), { params: { id: L1 }, deps: ctx('owner', OWNER).deps })).json();
  assert.deepEqual(own.documents.map((d) => d.doc_type).sort(), ['rate_confirmation', 'scale_ticket', 'scale_ticket']);
  assert.ok(own.documents.every((d) => d.url && d.label));
  assert.equal(own.documents.find((d) => d.id === DOC_ST).isImage, true);
  assert.equal(own.documents.find((d) => d.id === DOC_ST).file_path, undefined); // not his upload
  const drv = await (await LIST.GET(req('GET'), { params: { id: L1 }, deps: ctx('driver', DRIVER).deps })).json();
  assert.deepEqual(drv.documents.map((d) => d.doc_type).sort(), ['scale_ticket', 'scale_ticket']);
  assert.equal((await LIST.GET(req('GET'), { params: { id: L1 }, deps: ctx('driver', DRIVER2).deps })).status, 404);
  assert.equal((await LIST.GET(req('GET'), { params: { id: XL }, deps: ctx('owner', OWNER).deps })).status, 404);
});

test('suggest route: reads numbers once (cached) and suggests; driver sees only his loads', async () => {
  const { svc, deps } = ctx('driver', DRIVER);
  let calls = 0;
  svc.storage.from = () => ({ download: async () => ({ data: new Blob(['fake']) }) });
  svc.rpc = async () => ({ data: 'run1' });
  const d2 = { ...deps, env: { OPENAI_API_KEY: 'fake' }, runExtraction: async (kind) => { calls++; assert.equal(kind, 'load_doc'); return { data: { doc_kind: 'bol', reference_numbers: ['FAKE-5741'], doc_date: null } }; } };
  const j = await (await SUGGEST.GET(req('GET'), { params: { id: DOC_DRV }, deps: d2 })).json();
  assert.deepEqual(j.suggestion, { loadId: L1, reason: 'number' });
  assert.deepEqual(j.loads.map((l) => l.id), [L1]);
  await SUGGEST.GET(req('GET'), { params: { id: DOC_DRV }, deps: d2 });
  assert.equal(calls, 1);
});

test('wiring: Documents tab picker, load page via API with thumbnails, uploads link through the API', () => {
  const docs = read('../../app/documents/page.js');
  assert.match(docs, /isLoadDocType\(d\.doc_type\) \? \(\s*<DocLoadLink/);
  assert.match(docs, /body\.reclassified === 'bol' \|\| body\.reclassified === 'scale_ticket'/);
  assert.match(docs, /initialLoadId=\{scanLoadId\}/);
  const load = read('../../app/loads/[id]/page.js');
  assert.match(load, /fetchLoadDocs\(supabase, id\)/);
  assert.match(load, /<LoadDocThumb doc=\{d\}/);
  assert.match(read('../../app/lib/scanUpload.js'), /\/api\/documents\/\$\{row\.id\}\/load/);
  assert.match(read('../../app/api/extract/route.js'), /reclassifyLoadDoc\(admin, doc, user, finish, kind, loadData\)/);
});

// ---- QA round 1 (a)–(e) ----
import { fetchVisibleLoads, fetchVisibleLoad, ownCompanyFirst, isLoadOwnerView } from '../../app/lib/visibleLoads.js';
import { loadDeletePrompt } from '../../app/lib/loadDelete.js';
import * as TICKETS from '../../app/api/loads/[id]/scale-tickets/route.js';

test('(b) loads come from visible_loads(): driver gets rows; own company first; fallback only when the function is missing', async () => {
  const calls = [];
  const sb = (rpcRes, sel = { data: [{ id: 'own' }], error: null }) => ({
    rpc: async (fn, a) => { calls.push([fn, a]); return rpcRes; },
    from: () => ({ select: () => ({ order: async () => sel, eq: () => ({ maybeSingle: async () => ({ data: { id: 'own1' }, error: null }) }) }) }),
  });
  let r = await fetchVisibleLoads(sb({ data: [{ visible_loads: { id: L1, viewer_role: 'driver' } }], error: null }));
  assert.deepEqual(r.data.map((l) => l.id), [L1]);
  assert.deepEqual(calls[0], ['visible_loads', { p_statuses: null, p_load: null }]);
  r = await fetchVisibleLoads(sb({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }));
  assert.equal(r.viaRpc, false);
  r = await fetchVisibleLoads(sb({ data: null, error: { code: '500', message: 'boom' } }));
  assert.ok(r.error);
  assert.deepEqual(ownCompanyFirst([{ id: 1, viewer_role: 'owner' }, { id: 2, viewer_role: 'management' }]).map((l) => l.id), [1]);
  assert.deepEqual(ownCompanyFirst([{ id: 2, viewer_role: 'dispatcher' }]).map((l) => l.id), [2]);
  const one = await fetchVisibleLoad(sb({ data: [{ id: L1, viewer_role: 'management' }], error: null }), L1);
  assert.equal(one.data.id, L1);
  assert.ok(isLoadOwnerView({ viewer_role: 'owner' }) && isLoadOwnerView({}) && !isLoadOwnerView({ viewer_role: 'driver' }));
});

test('(b) wiring: /loads, /loads/[id] and the Documents scanner use visible_loads(); owner-only controls gated', () => {
  assert.match(read('../../app/loads/LoadsData.js'), /fetchVisibleLoads\(supabase/);
  assert.doesNotMatch(read('../../app/loads/LoadsData.js'), /\.from\('loads'\)/);
  const load = read('../../app/loads/[id]/page.js');
  assert.match(load, /fetchVisibleLoad\(supabase, id\)/);
  assert.match(load, /\{owner && <div style=\{\{ \.\.\.s\.card, borderColor: 'var\(--danger-border\)' \}\}>/);
  assert.match(load, /\{hasStatus && owner && \(/);
  assert.match(load, /Scan document/);
  assert.match(read('../../app/documents/page.js'), /await fetchVisibleLoads\(supabase\)/);
});

test('(c) delete prompt separates your documents from team documents', () => {
  assert.equal(loadDeletePrompt(3, true, {}, 1), 'Delete this load, its stops and your 3 documents? 1 team document will be kept, unlinked.');
  assert.equal(loadDeletePrompt(3, false, {}, 1), 'Delete this load and its stops? 4 documents will be kept, unlinked.');
  assert.equal(loadDeletePrompt(2, true, { expenses: 1 }), 'Delete this load, its stops and 2 documents? 1 expense will be kept, unlinked.');
  const load = read('../../app/loads/[id]/page.js');
  assert.match(load, /loadDeletePrompt\(ownDocs\.length, alsoDocs, linked, teamDocs\)/);
  assert.match(load, /team document\$\{teamDocs === 1 \? '' : 's'\} will be unlinked, not deleted/);
});

test('(a) Scale tickets box also returns scale-ticket documents linked to the load (not already on a ticket)', async () => {
  const { svc, deps } = ctx('owner', OWNER);
  await svc.from('documents').update({ load_id: L1 }).eq('id', DOC_DRV);
  await svc.from('documents').update({ doc_type: 'scale_ticket' }).eq('id', DOC_DRV);
  const ownDb = fakeSupabase({ tables: { ...seed(), company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: OWNER }, role: 'owner' });
  const j = await (await TICKETS.GET(req('GET'), { params: { id: L1 }, deps: { mkUserClient: () => ownDb, sb: svc } })).json();
  assert.deepEqual(j.ticketDocs.map((d) => d.id).sort(), [DOC_DRV, DOC_OWN].sort());
  assert.ok(j.ticketDocs.every((d) => d.url));
  const other = await (await TICKETS.GET(req('GET'), { params: { id: L1 }, deps: { ...ctx('driver', DRIVER2).deps } })).json();
  assert.deepEqual(other.ticketDocs || [], []); // not his load
});

test('(e) Change role: Also drives starts off unless the member already has it', () => {
  const inv = read('../../app/account/invite/page.js');
  assert.match(inv, /also: x\.also_drives === true, confirm: false/);
  assert.doesNotMatch(inv, /also: x\.role === 'driver' \|\|/);
});

test('(d) PDF thumbnails render page 1 with the shared pdf.js worker; tile fallback', () => {
  const t = read('../../app/components/LoadDocThumb.js');
  assert.match(t, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
  assert.match(t, /workerSrc = '\/pdfjs\/pdf\.worker\.min\.mjs'/);
  assert.match(t, /isPdf\(doc\) \? 'PDF' : 'DOC'/);
});

// ---- QA round 2: rate leak ----
import * as MAP from '../../app/api/loads/[id]/map/route.js';
import { mergeLoadPatch } from '../../app/lib/visibleLoads.js';

function mapCtxFor(role, userId, loadPatch = {}) {
  const tables = { loads: [{ id: L1, user_id: OWNER, rate: 2500, rate_per_mile: 2.5, total_miles: 1000, assigned_driver_user_id: DRIVER, show_rate_to_driver: false, ...loadPatch }], stops: [] };
  const svc = fakeSupabase({ tables });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { mkUserClient: () => uc, sb: svc, route: {} };
}
const mapJson = async (deps, method = 'GET') => { const r = await MAP[method](req(method), { params: { id: L1 }, deps }); return { status: r.status, j: await r.json() }; };

test('rate leak: map endpoint never sends rate/RPM to a driver without Show rate; 404 for an unassigned driver', async () => {
  let { status, j } = await mapJson(mapCtxFor('driver', DRIVER));
  assert.equal(status, 200);
  assert.doesNotMatch(JSON.stringify(j), /2\.5|2500/);
  ({ status } = await mapJson(mapCtxFor('driver', DRIVER2)));
  assert.equal(status, 404);
  ({ status } = await mapJson(mapCtxFor('driver', DRIVER2), 'POST'));
  assert.equal(status, 404);
  const v = { state: 'ready', load: { total_miles: 900, rate_per_mile: 2.5, rate: 1, calculated_miles: 880 } };
  assert.deepEqual(MAP.redactRate(v).load, { total_miles: 900, calculated_miles: 880 });
  assert.equal(v.load.rate_per_mile, 2.5); // not mutated
});

test('rate leak: client merge drops rate fields when the database said can_see_rate=false', () => {
  assert.deepEqual(mergeLoadPatch({ id: 1, can_see_rate: false, rate: null }, { total_miles: 900, rate_per_mile: 2.7 }), { id: 1, can_see_rate: false, rate: null, total_miles: 900 });
  assert.equal(mergeLoadPatch({ id: 1, can_see_rate: true }, { rate_per_mile: 2.7 }).rate_per_mile, 2.7);
  assert.equal(mergeLoadPatch({ id: 1 }, { rate_per_mile: 2.7 }).rate_per_mile, 2.7); // owner fallback (no flag)
  const load = read('../../app/loads/[id]/page.js');
  assert.doesNotMatch(load, /onLoadChange=\{\(patch\) => setLoad\(\(l\) => \(\{ \.\.\.l, \.\.\.patch \}\)\)\}/);
});

test('drivers: no Rate confirmation upload type, no ratecon@ card, no rate con in the scanner', () => {
  const d = read('../../app/documents/page.js');
  assert.match(d, /UPLOAD_TYPES\.filter\(\(t\) => !isDriver \|\| t\.id !== 'rate_confirmation'\)/);
  assert.match(d, /\{!isDriver && <RateconEmailCard/);
  assert.match(d, /if \(j\.role === 'driver'\) \{ setIsDriver\(true\)/);
});
