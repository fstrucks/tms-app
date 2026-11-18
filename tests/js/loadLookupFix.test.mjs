// Nov 18 2026: a Management/Dispatcher member added a load on /loads/new and it became a PERSONAL load (user_id = the
// member), so the company never saw it, the driver list was the member's own, and documents / ratings / scale tickets
// said "Load not found." Fake Test Trucking Co data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './fakeSupabase.mjs';
import { companyLoadTarget, createCompanyLoad, buildNewLoad } from '../../app/lib/loadNew.js';
import { withOwnerDriver } from '../../app/lib/loadDriver.js';
import { truckCtx } from '../../app/lib/truckServer.js';
import { LOAD_SCAN_TYPE_IDS, DOCUMENTS_SCAN_TYPE_IDS, SCAN_DOC_TYPES, docTypeLabel, uploadButtonLabel } from '../../app/lib/docTypes.js';
import * as LINK from '../../app/api/documents/[id]/load/route.js';
import * as LIST from '../../app/api/loads/[id]/documents/route.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1', MEMBER = '00000000-0000-4000-8000-0000000000a4', DRIVER = '00000000-0000-4000-8000-0000000000a2';
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000a9';
const L_COMPANY = '00000000-0000-4000-8000-0000000000b1', L_PERSONAL = '00000000-0000-4000-8000-0000000000b2', L_OTHER = '00000000-0000-4000-8000-0000000000b9';
const DOC = '00000000-0000-4000-8000-0000000000c1';

const req = (method, body, headers = {}) => new Request('http://x/api', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
function ctx(role, userId) {
  const svc = fakeSupabase({ tables: {
    loads: [
      { id: L_COMPANY, user_id: OWNER, broker_load_number: 'FAKE-1001', status: 'booked', created_at: '2026-11-18T00:00:00Z' },
      { id: L_PERSONAL, user_id: MEMBER, broker_load_number: 'FAKE-1002', status: 'booked', created_at: '2026-11-18T01:00:00Z' },
      { id: L_OTHER, user_id: OTHER_OWNER, broker_load_number: 'OTHER-1', status: 'booked', created_at: '2026-11-18T01:00:00Z' }],
    documents: [{ id: DOC, user_id: MEMBER, doc_type: 'bol', file_path: `${MEMBER}/1-bol.pdf`, original_filename: 'bol.pdf', load_id: null, created_at: '2026-11-18T02:00:00Z' }],
    scale_tickets: [],
    company_members: [{ user_id: MEMBER, role: 'management', 'company_profiles.owner_id': OWNER }, { user_id: DRIVER, role: 'driver', 'company_profiles.owner_id': OWNER }],
  } });
  svc.storage.from = () => ({ createSignedUrls: async () => ({ data: [] }) });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}

test('member of the company: a COMPANY load (user_id = owner) links documents and lists them', async () => {
  const { deps } = ctx('management', MEMBER);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L_COMPANY }), { params: { id: DOC }, deps })).status, 200);
  assert.equal((await LIST.GET(req('GET'), { params: { id: L_COMPANY }, deps })).status, 200);
});

test('repro of the report: a PERSONAL load of a member is not in the company, so company endpoints say Load not found', async () => {
  const { deps } = ctx('management', MEMBER);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L_PERSONAL }), { params: { id: DOC }, deps })).status, 404);
  assert.equal((await LIST.GET(req('GET'), { params: { id: L_PERSONAL }, deps })).status, 404);
});

test('security: another company’s load stays 404 for a member, and an unassigned driver still gets 404', async () => {
  const m = ctx('management', MEMBER);
  assert.equal((await LIST.GET(req('GET'), { params: { id: L_OTHER }, deps: m.deps })).status, 404);
  assert.equal((await LINK.PATCH(req('PATCH', { loadId: L_OTHER }), { params: { id: DOC }, deps: m.deps })).status, 404);
  const d = ctx('driver', DRIVER);
  assert.equal((await LIST.GET(req('GET'), { params: { id: L_COMPANY }, deps: d.deps })).status, 404);
});

test('companyLoadTarget: only an office member of someone else’s company adds loads to that company', () => {
  assert.deepEqual(companyLoadTarget({ owner_id: OWNER, role: 'management' }, MEMBER), { ownerId: OWNER });
  assert.deepEqual(companyLoadTarget({ owner_id: OWNER, role: 'dispatcher' }, MEMBER), { ownerId: OWNER });
  assert.equal(companyLoadTarget({ owner_id: OWNER, role: 'owner' }, OWNER), null); // owner: own account
  assert.equal(companyLoadTarget({ owner_id: OWNER, role: 'driver' }, DRIVER), null); // drivers don't create company loads here
  assert.equal(companyLoadTarget(null, MEMBER), null);
});

test('createCompanyLoad: saved through dispatch_create_load on the OWNER, never with the member as user_id', async () => {
  const form = { broker_name: 'Sample Freight', broker_load_number: 'FAKE-2001', rate: '1,280', miles: '300', weight: '38,500', pu_city: 'Fresno', pu_state: 'ca', del_city: 'Reno', del_state: 'NV', pu_pickup_number: 'PU-1', driver_user_id: OWNER };
  const built = buildNewLoad(form, { userId: MEMBER, timezone: 'America/Los_Angeles' });
  assert.ok(built.load, JSON.stringify(built.errors));
  let call = null;
  const sb = { rpc: async (fn, args) => { call = { fn, args }; return { data: L_COMPANY, error: null }; } };
  const r = await createCompanyLoad(sb, OWNER, built);
  assert.deepEqual(r, { ok: true, id: L_COMPANY });
  assert.equal(call.fn, 'dispatch_create_load');
  assert.equal(call.args.p_owner, OWNER);
  assert.equal('user_id' in call.args.p_load, false);
  assert.equal(call.args.p_load.assigned_driver_user_id, OWNER); // the owner can be the driver
  assert.equal(call.args.p_load.rate, 1280); assert.equal(call.args.p_load.total_miles, 300); assert.equal(call.args.p_load.broker_name, 'Sample Freight');
  assert.equal(call.args.p_stops.length, 2);
  assert.equal(call.args.p_stops[0].pickup_number, 'PU-1');
  assert.equal(call.args.p_stops.some((s) => 'sequence' in s), false);
  const bad = await createCompanyLoad({ rpc: async () => ({ data: null, error: { message: 'not_allowed' } }) }, OWNER, built);
  assert.equal(bad.ok, false);
});

test('driver list on a member’s New load includes the owner (Marc can be the driver)', () => {
  const list = withOwnerDriver([{ user_id: DRIVER, email: 'driver@test.invalid' }], OWNER);
  assert.ok(list.some((c) => c.user_id === OWNER && c.owner));
  assert.ok(list.some((c) => c.user_id === DRIVER));
});

test('truckCtx: a user in two companies gets the ACTIVE one, not whichever row came first', async () => {
  const P_OWN = { id: '0a0a0a0a-0001', owner_id: MEMBER, created_at: '2026-10-01T00:00:00Z' }, P_TEAM = { id: '0a0a0a0a-0002', owner_id: OWNER, created_at: '2026-10-05T00:00:00Z' };
  const members = [{ profile_id: '0a0a0a0a-0002', user_id: MEMBER, role: 'management', created_at: '2026-10-05T00:00:00Z' }];
  const mk = () => fakeSupabase({ tables: { company_profiles: [P_OWN, P_TEAM], company_members: members }, user: { id: MEMBER }, role: 'management' });
  const svc = fakeSupabase({ tables: {} });
  const cookie = (id) => ({ cookie: `ph_active_company=${encodeURIComponent(`${MEMBER}.${id}`)}` });
  const a = await truckCtx(req('GET', null, cookie('0a0a0a0a-0002')), { mkUserClient: mk, sb: svc });
  assert.equal(a.ownerId, OWNER);
  const b = await truckCtx(req('GET', null, cookie('0a0a0a0a-0001')), { mkUserClient: mk, sb: svc });
  assert.equal(b.ownerId, MEMBER);
  const forged = await truckCtx(req('GET', null, cookie('0a0a0a0a-0003')), { mkUserClient: mk, sb: svc });
  assert.equal(forged.ownerId, MEMBER); // falls back to the default (owned company), never to a company the user isn't in
});

test('Scan document: Rate confirmation is offered on the load page only, stored as rate_confirmation', () => {
  assert.ok(LOAD_SCAN_TYPE_IDS.includes('rate_confirmation'));
  assert.deepEqual(LOAD_SCAN_TYPE_IDS, ['bol', 'pod', 'lumper_receipt', 'scale_ticket', 'rate_confirmation', 'other']);
  assert.equal(docTypeLabel('rate_confirmation'), 'Rate confirmation');
  assert.equal(SCAN_DOC_TYPES.find((t) => t.id === 'rate_confirmation').label, 'Rate confirmation');
  assert.equal(DOCUMENTS_SCAN_TYPE_IDS.includes('rate_confirmation'), false); // Documents page has its own Rate Confirmation entry
  assert.equal(uploadButtonLabel('rate_confirmation'), 'Upload Rate Confirmation');
});
