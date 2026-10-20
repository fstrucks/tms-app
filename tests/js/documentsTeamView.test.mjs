// Documents tab "Team" view: same access as PR #110 load documents. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import * as TEAM from '../../app/api/documents/team/route.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', DRIVER2 = '00000000-0000-4000-8000-0000000000a3', MGMT = '00000000-0000-4000-8000-0000000000a4', DISP = '00000000-0000-4000-8000-0000000000a5', OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1', L2 = '00000000-0000-4000-8000-0000000000b2', XL = '00000000-0000-4000-8000-0000000000b9';
const D = (n) => `00000000-0000-4000-8000-0000000000c${n}`;
const seed = () => ({
  loads: [{ id: L1, user_id: OWNER, broker_load_number: 'FAKE-5741', status: 'in_transit', assigned_driver_user_id: DRIVER, show_rate_to_driver: false, created_at: '2026-10-19T00:00:00Z' },
    { id: L2, user_id: OWNER, broker_load_number: 'FAKE-6000', status: 'booked', assigned_driver_user_id: DRIVER2, show_rate_to_driver: true, created_at: '2026-10-18T00:00:00Z' },
    { id: XL, user_id: OTHER, broker_load_number: 'OTHER-1', created_at: '2026-10-18T00:00:00Z' }],
  documents: [
    { id: D(1), user_id: DRIVER, doc_type: 'bol', file_path: `${DRIVER}/1-bol.jpg`, original_filename: 'bol.jpg', load_id: L1, created_at: '2026-10-20T00:00:00Z' },
    { id: D(2), user_id: OWNER, doc_type: 'rate_confirmation', file_path: `${OWNER}/2-rc.pdf`, original_filename: 'rc1.pdf', load_id: L1, created_at: '2026-10-19T00:00:00Z' },
    { id: D(3), user_id: DRIVER2, doc_type: 'pod', file_path: `${DRIVER2}/3-pod.pdf`, original_filename: 'pod.pdf', load_id: L2, created_at: '2026-10-20T03:00:00Z' },
    { id: D(4), user_id: OWNER, doc_type: 'rate_confirmation', file_path: `${OWNER}/4-rc.pdf`, original_filename: 'rc2.pdf', load_id: L2, created_at: '2026-10-18T00:00:00Z' },
    { id: D(5), user_id: DRIVER, doc_type: 'scale_ticket', file_path: `${DRIVER}/5-cat.jpg`, original_filename: 'cat.jpg', load_id: null, created_at: '2026-10-20T02:00:00Z' },
    { id: D(6), user_id: DRIVER, doc_type: 'bol', file_path: `${DRIVER}/6-unlinked.jpg`, original_filename: 'unlinked.jpg', load_id: null, created_at: '2026-10-20T04:00:00Z' },
    { id: D(7), user_id: OWNER, doc_type: 'receipt', file_path: `${OWNER}/7-r.jpg`, original_filename: 'fuel.jpg', load_id: L1, created_at: '2026-10-20T05:00:00Z' },
    { id: D(8), user_id: OTHER, doc_type: 'bol', file_path: `${OTHER}/8.pdf`, original_filename: 'x.pdf', load_id: XL, created_at: '2026-10-20T00:00:00Z' }],
  scale_tickets: [{ id: 't1', user_id: OWNER, load_id: L1, document_id: D(5) }],
  company_members: [DRIVER, DRIVER2, MGMT, DISP].map((u) => ({ user_id: u, 'company_profiles.owner_id': OWNER })),
});
function ctx(role, userId) {
  const svc = fakeSupabase({ tables: seed() });
  svc.storage.from = () => ({ createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://fake.invalid/${p}` })) }) });
  svc.auth = { ...(svc.auth || {}), admin: { getUserById: async (id) => ({ data: { user: { id, email: `${id.slice(-3)}@example.test`, user_metadata: id === DRIVER ? { full_name: 'Test Driver' } : {} } } }) } };
  const from = svc.from.bind(svc);
  svc.from = (t) => { const q = from(t); q.not = () => q; return q; };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { mkUserClient: () => uc, sb: svc };
}
const get = async (role, uid) => (await TEAM.GET(new Request('http://x/api/documents/team', { headers: { authorization: 'Bearer t' } }), { deps: ctx(role, uid) })).json();
const ids = (j) => j.documents.map((d) => d.id).sort();

test('team view: owner / management / dispatcher see every linked company load doc (no receipts, no unlinked, no other company)', async () => {
  for (const [r, u] of [['owner', OWNER], ['management', MGMT], ['dispatcher', DISP]]) {
    const j = await get(r, u);
    assert.deepEqual(ids(j), [D(1), D(2), D(3), D(4), D(5)].sort(), r);
  }
});

test('team view: driver sees only assigned loads, no rate con unless Show rate is on', async () => {
  assert.deepEqual(ids(await get('driver', DRIVER)), [D(1), D(5)].sort()); // L1: show rate off → rc hidden
  assert.deepEqual(ids(await get('driver', DRIVER2)), [D(3), D(4)].sort()); // L2: show rate on
});

test('team view: uploader name, load label; delete path only on own uploads', async () => {
  const j = await get('owner', OWNER);
  const bol = j.documents.find((d) => d.id === D(1));
  assert.equal(bol.uploader, 'Test Driver');
  assert.equal(bol.own, false); assert.equal(bol.file_path, undefined);
  assert.match(bol.load_label, /FAKE-5741/); assert.equal(bol.load_id, L1);
  assert.ok(bol.url);
  const rc = j.documents.find((d) => d.id === D(2));
  assert.equal(rc.uploader, 'You'); assert.equal(rc.own, true); assert.ok(rc.file_path);
  assert.equal(j.documents.find((d) => d.id === D(5)).load_id, L1); // linked through the scale ticket
});

test('team view: no sign-in → 401', async () => {
  const r = await TEAM.GET(new Request('http://x/api/documents/team'), { deps: ctx('owner', OWNER) });
  assert.equal(r.status, 401);
});

test('documents page: Mine is default, Team toggle renders TeamDocsList; delete only for own rows', () => {
  const page = readFileSync(new URL('../../app/documents/page.js', import.meta.url), 'utf8');
  assert.match(page, /useState\('mine'\)/);
  assert.match(page, /<TeamDocsList /);
  const list = readFileSync(new URL('../../app/components/TeamDocsList.js', import.meta.url), 'utf8');
  assert.match(list, /d\.own && d\.file_path && <ConfirmButton/);
});
