// Delete a handled email rate con from the uploader's own Load documents list.
// Fake rows only. Needs attention, #144 linking, and the load-delete stamp stay as they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { pageLoadVault } from '../../app/lib/loadVault.js';
import { vaultTileCounts } from '../../app/lib/vaultCounts.js';
import { canDeleteHandledEmailRatecon, deleteHandledEmailRatecon } from '../../app/lib/documents.js';
import * as VAULT from '../../app/api/documents/vault/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const DRIVER = '00000000-0000-4000-8000-0000000000a2';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const handled = (id, userId, extra = {}) => ({
  id, user_id: userId, doc_type: 'rate_confirmation', source: 'email', load_id: null,
  truck_id: null, service_record_id: null, handled_at: '2026-10-24T12:00:00Z',
  file_path: `${userId}/${id}.pdf`, original_filename: `${id}.pdf`, created_at: at(40),
  ...extra,
});

function filed(n, userId = OWNER) {
  return {
    id: `filed-${n}`, user_id: userId, doc_type: 'bol', source: 'upload', load_id: L1,
    handled_at: null, file_path: `${userId}/b${n}.pdf`, original_filename: `b${n}.pdf`, created_at: at(n + 1),
  };
}

function load(id, extra = {}) {
  return {
    id, user_id: OWNER, broker_name: 'Acme (FAKE)', broker_load_number: 'FAKE-100', status: 'delivered',
    assigned_driver_user_id: DRIVER, show_rate_to_driver: false, created_at: at(1), ...extra,
  };
}

function tablesFor(documents, extra = {}) {
  return {
    company_members: [{ user_id: DRIVER, 'company_profiles.owner_id': OWNER }],
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    loads: [load(L1)],
    drivers: [],
    scale_tickets: [],
    documents,
    ...extra,
  };
}

test('delete shows only for the viewer’s own handled email rate con', () => {
  const own = handled('own', OWNER);
  assert.equal(canDeleteHandledEmailRatecon(own, OWNER), true);
  assert.equal(canDeleteHandledEmailRatecon(handled('theirs', DRIVER), OWNER), false);
  assert.equal(canDeleteHandledEmailRatecon(handled('upload', OWNER, { source: 'upload' }), OWNER), false);
  assert.equal(canDeleteHandledEmailRatecon(handled('bol', OWNER, { doc_type: 'bol', source: 'upload' }), OWNER), false);
  assert.equal(canDeleteHandledEmailRatecon(handled('open', OWNER, { handled_at: null }), OWNER), false);
  assert.equal(canDeleteHandledEmailRatecon(handled('blank', OWNER, { handled_at: '' }), OWNER), false);
  assert.equal(canDeleteHandledEmailRatecon(own, null), false);
  assert.equal(canDeleteHandledEmailRatecon(own, DRIVER), false);
});

test('zero deleted rows is an error and does not pretend the file is gone', async () => {
  const doc = handled('own', OWNER);
  const calls = [];
  const sb = {
    from: () => ({ delete: () => ({ eq: () => ({ select: async () => { calls.push('db'); return { data: [], error: null }; } }) }) }),
    storage: { from: () => ({ remove: async () => { calls.push('storage'); return { error: null }; } }) },
  };
  const r = await deleteHandledEmailRatecon(sb, doc, OWNER);
  assert.equal(r.ok, false);
  assert.match(r.error, /not found or not permitted/);
  assert.deepEqual(calls, ['db']);

  const blocked = await deleteHandledEmailRatecon(sb, handled('theirs', DRIVER), OWNER);
  assert.equal(blocked.ok, false);
  assert.deepEqual(calls, ['db']);
});

test('load documents tile count matches the list, including handled rows the list shows', async () => {
  const ownHandled = handled('kept', OWNER);
  const draft = handled('draft', OWNER, { handled_at: null, created_at: at(50) });
  const docs = [...Array.from({ length: 11 }, (_, i) => filed(i)), ownHandled, draft];
  const loads = [load(L1)];
  const page = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 50 });
  assert.equal(page.rows.some((r) => r.doc.id === 'kept'), true);
  assert.equal(page.rows.some((r) => r.doc.id === 'draft'), false);
  assert.equal(page.rows.length, 12);
  const counts = await vaultTileCounts(fakeSupabase({ tables: tablesFor(docs) }), { ownerId: OWNER, role: 'owner', userId: OWNER, profileId: 'p1' });
  assert.equal(counts.loadDocs, page.rows.length);

  const viaTicket = handled('team-kept', DRIVER);
  const linked = [...Array.from({ length: 11 }, (_, i) => filed(i)), viaTicket];
  const tickets = [{ document_id: 'team-kept', user_id: OWNER, load_id: L1, confirmed: true }];
  const shown = pageLoadVault({ docs: linked, loads, ticketLoads: tickets, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 50 });
  assert.equal(shown.rows.some((r) => r.doc.id === 'team-kept'), true);
  assert.equal(shown.rows.length, 12);
  const ticketCounts = await vaultTileCounts(fakeSupabase({ tables: tablesFor(linked, { scale_tickets: tickets }) }), { ownerId: OWNER, role: 'owner', userId: OWNER, profileId: 'p1' });
  assert.equal(ticketCounts.loadDocs, shown.rows.length);

  const hidden = pageLoadVault({ docs: linked, loads, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 50 });
  assert.equal(hidden.rows.some((r) => r.doc.id === 'team-kept'), false);
  assert.equal(hidden.rows.length, 11);
  const hiddenCounts = await vaultTileCounts(fakeSupabase({ tables: tablesFor(linked) }), { ownerId: OWNER, role: 'owner', userId: OWNER, profileId: 'p1' });
  assert.equal(hiddenCounts.loadDocs, hidden.rows.length);

  const asUploader = pageLoadVault({ docs: linked, loads, ticketLoads: tickets, role: 'driver', userId: DRIVER, ownerId: OWNER, limit: 50 });
  assert.equal(asUploader.rows.some((r) => r.doc.id === 'team-kept'), true);
  const uploaderCounts = await vaultTileCounts(fakeSupabase({ tables: tablesFor(linked, { scale_tickets: tickets }) }), { ownerId: OWNER, role: 'driver', userId: DRIVER, profileId: 'p1' });
  assert.equal(uploaderCounts.loadDocs, asUploader.rows.length);

  const ownerOnly = handled('owner-kept', OWNER);
  const driverDocs = [...Array.from({ length: 11 }, (_, i) => filed(i)), ownerOnly];
  const driverTickets = [{ document_id: 'owner-kept', user_id: OWNER, load_id: L1, confirmed: true }];
  const driverPage = pageLoadVault({ docs: driverDocs, loads, ticketLoads: driverTickets, role: 'driver', userId: DRIVER, ownerId: OWNER, limit: 50 });
  assert.equal(driverPage.rows.some((r) => r.doc.id === 'owner-kept'), false);
  assert.equal(driverPage.rows.length, 11);
  const driverCounts = await vaultTileCounts(fakeSupabase({ tables: tablesFor(driverDocs, { scale_tickets: driverTickets }) }), { ownerId: OWNER, role: 'driver', userId: DRIVER, profileId: 'p1' });
  assert.equal(driverCounts.loadDocs, driverPage.rows.length);
});

function ctx(role, userId, tables) {
  const svc = fakeSupabase({ tables, user: { id: userId }, role });
  svc.storage.from = () => ({ createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://fake.invalid/${p}` })) }) });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { mkUserClient: () => uc, sb: svc };
}

test('vault list payload marks delete only on the viewer’s own handled email rate con', async () => {
  const docs = [
    handled('own', OWNER),
    handled('theirs', DRIVER, { load_id: L1 }),
    handled('upload', OWNER, { source: 'upload', load_id: L1, created_at: at(3) }),
    handled('open', OWNER, { handled_at: null, load_id: L1, created_at: at(2) }),
  ];
  const res = await VAULT.GET(new Request('http://x/api/documents/vault', { headers: { authorization: 'Bearer t' } }), { deps: ctx('owner', OWNER, tablesFor(docs)) });
  const body = await res.json();
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(body.documents.map((d) => [d.id, d]));
  assert.equal(byId.own.user_id, OWNER);
  assert.equal(byId.own.source, 'email');
  assert.equal(byId.own.handled_at, '2026-10-24T12:00:00Z');
  assert.equal(canDeleteHandledEmailRatecon(byId.own, OWNER), true);
  assert.equal(byId.own.file_path, `${OWNER}/own.pdf`);
  for (const id of ['theirs', 'upload', 'open']) assert.equal(canDeleteHandledEmailRatecon(byId[id], OWNER), false, id);
  assert.equal(byId.theirs.user_id, undefined);
  assert.equal(byId.theirs.file_path, undefined);
  assert.equal(byId.upload.user_id, OWNER);
  assert.equal(byId.upload.file_path, `${OWNER}/upload.pdf`);
});

test('the load vault page deletes through the helper, with a confirm step and a 44px target', () => {
  const page = read('../../app/documents/vault/page.js');
  const button = read('../../app/components/ui/ConfirmButton.js');
  assert.match(page, /canDeleteHandledEmailRatecon\(d, userId\)/);
  assert.match(page, /deleteHandledEmailRatecon\(supabase, d, userId\)/);
  assert.match(page, /data-testid="handled-ratecon-delete"/);
  assert.match(page, /data-confirm-row/);
  assert.match(button, /minHeight: 44/);
  assert.match(button, /minWidth: 44/);
  const removeFn = page.slice(page.indexOf('async function removeDoc'), page.indexOf('function search'));
  assert.match(removeFn, /if \(!r\.ok\)/);
  assert.doesNotMatch(removeFn, /missingOk/);
  const helpers = read('../../app/lib/documents.js');
  const fn = helpers.slice(helpers.indexOf('export async function deleteHandledEmailRatecon'), helpers.indexOf('// Delete a document:'));
  assert.match(fn, /return deleteDocument\(supabase, doc, 'documents'\)/);
  assert.doesNotMatch(fn, /missingOk/);
});
