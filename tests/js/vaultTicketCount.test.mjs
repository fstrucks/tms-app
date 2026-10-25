// Load documents tile vs vault list when a file is filed only through scale_tickets.
// Fake rows only. No live database. #144 linking, #147 handled_at, and #148 delete stay as they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { pageLoadVault } from '../../app/lib/loadVault.js';
import { vaultTileCounts } from '../../app/lib/vaultCounts.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const DRIVER = '00000000-0000-4000-8000-0000000000a2';
const DISP = '00000000-0000-4000-8000-0000000000a4';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const TRUCK = '00000000-0000-4000-8000-0000000000c1';
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function load(id, extra = {}) {
  return {
    id, user_id: OWNER, broker_name: 'Acme (FAKE)', broker_load_number: 'FAKE-100', status: 'delivered',
    assigned_driver_user_id: DRIVER, show_rate_to_driver: false, created_at: at(1), ...extra,
  };
}

function bol(n, userId = OWNER) {
  return {
    id: `bol-${n}`, user_id: userId, doc_type: 'bol', source: 'upload', load_id: L1,
    truck_id: null, service_record_id: null, handled_at: null,
    file_path: `${userId}/b${n}.pdf`, original_filename: `b${n}.pdf`, created_at: at(n + 2),
  };
}

// Truck tab scan: documents.load_id stays null. Confirm writes scale_tickets.load_id.
function scalePhoto(id, userId) {
  return {
    id, user_id: userId, doc_type: 'scale_ticket', source: 'upload', load_id: null,
    truck_id: TRUCK, service_record_id: null, handled_at: null,
    file_path: `${userId}/${id}.jpg`, original_filename: `${id}.jpg`, created_at: at(80),
  };
}

function ticket(docId, extra = {}) {
  return {
    id: `tk-${docId}`, document_id: docId, user_id: OWNER, truck_id: TRUCK, trailer_id: null,
    load_id: L1, confirmed: true, created_at: at(81), ...extra,
  };
}

function handledRatecon(id, userId) {
  return {
    id, user_id: userId, doc_type: 'rate_confirmation', source: 'email', load_id: null,
    truck_id: null, service_record_id: null, handled_at: '2026-10-24T12:00:00Z',
    file_path: `${userId}/${id}.pdf`, original_filename: `${id}.pdf`, created_at: at(70),
  };
}

function tablesFor(documents, scale_tickets) {
  return {
    company_members: [
      { user_id: DRIVER, 'company_profiles.owner_id': OWNER },
      { user_id: DISP, 'company_profiles.owner_id': OWNER },
    ],
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    loads: [load(L1)],
    drivers: [],
    scale_tickets,
    documents,
  };
}

function listed(documents, tickets, role, userId) {
  return pageLoadVault({
    docs: documents, loads: [load(L1)], ticketLoads: tickets, role, userId, ownerId: OWNER, limit: 50,
  });
}

async function counted(documents, tickets, role, userId) {
  return vaultTileCounts(fakeSupabase({ tables: tablesFor(documents, tickets) }), {
    ownerId: OWNER, role, userId, profileId: 'p1',
  });
}

const bols = (n) => Array.from({ length: n }, (_, i) => bol(i));

// The in-memory client returns every column. The vault list query does not, so a test of that
// list has to drop truck_id and service_record_id the same way.
const LIST_COLS = readFileSync(new URL('../../app/lib/loadVaultQuery.js', import.meta.url), 'utf8').match(/const DOC_COLS = '([^']+)'/)[1].split(',').map((c) => c.trim());

function asListDoc(doc) {
  const out = {};
  for (const key of LIST_COLS) out[key] = doc[key];
  return out;
}

function listedLikeTheApi(documents, tickets, role, userId) {
  return pageLoadVault({
    docs: documents.map(asListDoc), loads: [load(L1)], ticketLoads: tickets, role, userId, ownerId: OWNER, limit: 50,
  });
}

test('dispatcher tile matches the list when the owner scale ticket is confirmed onto a load', async () => {
  const photo = scalePhoto('owner-ticket', OWNER);
  const documents = [...bols(12), photo];
  const tickets = [ticket(photo.id)];
  const page = listed(documents, tickets, 'dispatcher', DISP);
  assert.equal(page.rows.some((r) => r.doc.id === photo.id), true);
  assert.equal(page.rows.length, 13);
  const counts = await counted(documents, tickets, 'dispatcher', DISP);
  assert.equal(counts.loadDocs, page.rows.length);
});

test('owner tile still matches the list for that same scale ticket', async () => {
  const photo = scalePhoto('owner-ticket', OWNER);
  const documents = [...bols(12), photo];
  const tickets = [ticket(photo.id)];
  const page = listed(documents, tickets, 'owner', OWNER);
  assert.equal(page.rows.length, 13);
  const counts = await counted(documents, tickets, 'owner', OWNER);
  assert.equal(counts.loadDocs, page.rows.length);
});

test('a scale ticket the dispatcher scanned is counted for both office viewers', async () => {
  const photo = scalePhoto('disp-ticket', DISP);
  const documents = [...bols(12), photo];
  const tickets = [ticket(photo.id)];
  const asDispatcher = listed(documents, tickets, 'dispatcher', DISP);
  const dispatcherCounts = await counted(documents, tickets, 'dispatcher', DISP);
  assert.equal(asDispatcher.rows.some((r) => r.doc.id === photo.id), true);
  assert.equal(dispatcherCounts.loadDocs, asDispatcher.rows.length);

  const asOwner = listed(documents, tickets, 'owner', OWNER);
  const ownerCounts = await counted(documents, tickets, 'owner', OWNER);
  assert.equal(asOwner.rows.some((r) => r.doc.id === photo.id), true);
  assert.equal(asOwner.rows.length, 13);
  assert.equal(ownerCounts.loadDocs, asOwner.rows.length);
});

test('a teammate handled email rate con with a ticket is counted once', async () => {
  const kept = handledRatecon('kept', OWNER);
  const documents = [kept];
  const tickets = [ticket(kept.id)];
  const asDispatcher = listed(documents, tickets, 'dispatcher', DISP);
  const dispatcherCounts = await counted(documents, tickets, 'dispatcher', DISP);
  assert.deepEqual(asDispatcher.rows.map((r) => r.doc.id), [kept.id]);
  assert.equal(dispatcherCounts.loadDocs, 1);

  const asOwner = listed(documents, tickets, 'owner', OWNER);
  const ownerCounts = await counted(documents, tickets, 'owner', OWNER);
  assert.equal(asOwner.rows.length, 1);
  assert.equal(ownerCounts.loadDocs, 1);
});

test('a scale ticket with no load stays out of the dispatcher list and tile', async () => {
  const photo = scalePhoto('truck-only', OWNER);
  const documents = [...bols(12), photo];
  const tickets = [ticket(photo.id, { load_id: null })];
  const asOwner = listed(documents, tickets, 'owner', OWNER);
  const ownerCounts = await counted(documents, tickets, 'owner', OWNER);
  assert.equal(asOwner.rows.some((r) => r.doc.id === photo.id), true);
  assert.equal(asOwner.rows.length, 13);
  assert.equal(ownerCounts.loadDocs, asOwner.rows.length);

  const asDispatcher = listed(documents, tickets, 'dispatcher', DISP);
  const dispatcherCounts = await counted(documents, tickets, 'dispatcher', DISP);
  assert.equal(asDispatcher.rows.some((r) => r.doc.id === photo.id), false);
  assert.equal(asDispatcher.rows.length, 12);
  assert.equal(dispatcherCounts.loadDocs, asDispatcher.rows.length);
});

test('deleting one linked BOL keeps the dispatcher tile equal to the list', async () => {
  const photo = scalePhoto('owner-ticket', OWNER);
  const tickets = [ticket(photo.id)];
  const before = [...bols(12), photo];
  const beforePage = listed(before, tickets, 'dispatcher', DISP);
  const beforeCounts = await counted(before, tickets, 'dispatcher', DISP);
  assert.equal(beforePage.rows.length, 13);
  assert.equal(beforeCounts.loadDocs, beforePage.rows.length);

  const after = before.filter((d) => d.id !== 'bol-0');
  const afterPage = listed(after, tickets, 'dispatcher', DISP);
  const afterCounts = await counted(after, tickets, 'dispatcher', DISP);
  assert.equal(afterPage.rows.length, 12);
  assert.equal(afterCounts.loadDocs, afterPage.rows.length);
  assert.equal(afterPage.rows.some((r) => r.doc.id === photo.id), true);
});

test('ticket-only rows past 200 are still counted for the dispatcher', async () => {
  const n = 201;
  const documents = [];
  const tickets = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    documents.push({ ...scalePhoto(id, OWNER), created_at: at(100 + i) });
    tickets.push({ ...ticket(id), id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, created_at: at(400 + i) });
  }
  const page = pageLoadVault({
    docs: documents, loads: [load(L1)], ticketLoads: tickets, role: 'dispatcher', userId: DISP, ownerId: OWNER, limit: n,
  });
  assert.equal(page.rows.length, n);
  const counts = await counted(documents, tickets, 'dispatcher', DISP);
  assert.equal(counts.loadDocs, n);
});

test('Remove leaves the scale ticket photo in the database and drops it from the owner tile', async () => {
  assert.equal(LIST_COLS.includes('truck_id'), false);
  const photos = [scalePhoto('ticket-a', OWNER), scalePhoto('ticket-b', OWNER)];
  const documents = [...bols(11), ...photos];
  const linked = photos.map((p) => ticket(p.id));
  const before = listedLikeTheApi(documents, linked, 'owner', OWNER);
  const beforeCounts = await counted(documents, linked, 'owner', OWNER);
  assert.equal(before.rows.length, 13);
  assert.equal(beforeCounts.loadDocs, before.rows.length);

  // Load delete nulls scale_tickets.load_id. The weight row and the photo stay.
  const unlinked = linked.map((t) => ({ ...t, load_id: null }));
  const afterLoad = listedLikeTheApi(documents, unlinked, 'owner', OWNER);
  const afterLoadCounts = await counted(documents, unlinked, 'owner', OWNER);
  assert.equal(afterLoad.rows.some((r) => r.doc.id === 'ticket-a'), true);
  assert.equal(afterLoad.rows.some((r) => r.doc.id === 'ticket-b'), true);
  assert.equal(afterLoadCounts.loadDocs, afterLoad.rows.length);

  // Truck → Remove deletes the scale_tickets row only. documents.truck_id stays set.
  const afterRemove = listedLikeTheApi(documents, [], 'owner', OWNER);
  const afterRemoveCounts = await counted(documents, [], 'owner', OWNER);
  assert.equal(afterRemove.rows.some((r) => r.doc.id === 'ticket-a' || r.doc.id === 'ticket-b'), false);
  assert.equal(afterRemove.rows.length, 11);
  assert.equal(afterRemoveCounts.loadDocs, 11);
});
