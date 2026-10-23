// Docs tab inbox + vaults. Fake rows only. No live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { mergeInboxDocs, readInboxOpen, writeInboxOpen, INBOX_OPEN_KEY, INBOX_RECENT_CAP } from '../../app/lib/docsInbox.js';
import { MAINTENANCE_VAULT_ENABLED, fetchMaintenanceCount, maintenanceVaultHref } from '../../app/lib/maintenanceVault.js';
import { pageLoadVault, canSeeVaultDoc, reversedDateRange, DATE_RANGE_ERROR } from '../../app/lib/loadVault.js';
import { fetchVaultPage } from '../../app/lib/loadVaultQuery.js';
import { selectInboxTeamDocs } from '../../app/lib/docsInboxQuery.js';
import { groupDriverVault } from '../../app/lib/driverVault.js';
import { vaultTileCounts } from '../../app/lib/vaultCounts.js';
import { isEmailDraft } from '../../app/lib/rateconDrafts.js';
import * as VAULT from '../../app/api/documents/vault/route.js';
import * as DRIVERS from '../../app/api/documents/drivers/route.js';
import * as TEAM from '../../app/api/documents/team/route.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const DRIVER = '00000000-0000-4000-8000-0000000000a2';
const DRIVER2 = '00000000-0000-4000-8000-0000000000a3';
const OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1';
const L2 = '00000000-0000-4000-8000-0000000000b2';
const XL = '00000000-0000-4000-8000-0000000000b9';
const P1 = '00000000-0000-4000-8000-0000000000d1';
const P2 = '00000000-0000-4000-8000-0000000000d2';
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const memStore = () => ({ store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } });

test('inbox keeps every waiting rate con and caps recent uploads', () => {
  const waiting = [
    { id: 'w-old', source: 'email', load_id: null, doc_type: 'rate_confirmation', created_at: '2020-01-01T00:00:00Z' },
    { id: 'w-new', source: 'email', load_id: null, doc_type: 'rate_confirmation', created_at: '2026-10-22T00:00:00Z' },
    { id: 'not', source: 'email', load_id: null, doc_type: 'rate_confirmation', extraction_error: 'not_ratecon', created_at: '2026-10-22T00:00:00Z' },
  ];
  assert.equal(isEmailDraft(waiting[2]), false);
  const recent = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, doc_type: 'bol', created_at: at(i + 1) }));
  recent.push(waiting[1]);
  const merged = mergeInboxDocs(recent, waiting);
  assert.deepEqual(merged.slice(0, 2).map((d) => d.id), ['w-old', 'w-new']);
  assert.equal(merged.filter((d) => d.id.startsWith('r')).length, INBOX_RECENT_CAP);
  assert.equal(merged.some((d) => d.id === 'not'), false);
  assert.equal(merged.filter((d) => d.id === 'w-new').length, 1);
});

test('inbox open/closed is remembered, and defaults to open', () => {
  const s = memStore();
  assert.equal(readInboxOpen(s), true);
  assert.equal(readInboxOpen(null), true);
  writeInboxOpen(s, false);
  assert.equal(s.store[INBOX_OPEN_KEY], '0');
  assert.equal(readInboxOpen(s), false);
  writeInboxOpen(s, true);
  assert.equal(readInboxOpen(s), true);
});

test('maintenance tile stays off and does not call the count RPC', async () => {
  assert.equal(MAINTENANCE_VAULT_ENABLED, false);
  let calls = 0;
  const supabase = { rpc: async (name) => { calls += 1; assert.equal(name, 'maintenance_vault_count'); return { data: 4, error: null }; } };
  const hidden = await fetchMaintenanceCount(supabase);
  assert.equal(hidden.called, false);
  assert.equal(calls, 0);
  const shown = await fetchMaintenanceCount(supabase, { enabled: true });
  assert.equal(shown.called, true);
  assert.equal(shown.count, 4);
  assert.equal(calls, 1);
  assert.equal(maintenanceVaultHref(), '/maintenance/vault');
  assert.equal(maintenanceVaultHref('truck 1'), '/maintenance/vault?truck=truck%201');
});

function load(id, extra) {
  return { id, user_id: OWNER, broker_name: 'Acme (FAKE)', broker_load_number: 'FAKE-100', status: 'delivered', assigned_driver_user_id: DRIVER, show_rate_to_driver: false, created_at: at(1), ...extra };
}

test('load vault visibility: own files, team files on openable loads, no receipts or company docs', () => {
  const loads = [
    load(L1),
    load(L2, { broker_name: 'Beta (FAKE)', broker_load_number: 'FAKE-200', assigned_driver_user_id: DRIVER2, show_rate_to_driver: true, status: 'booked' }),
  ];
  const docs = [
    { id: 'own-loose', user_id: OWNER, doc_type: 'rate_confirmation', load_id: null, created_at: at(9), ai_extracted_data: { broker_name: 'Acme (FAKE)', load_number: 'FAKE-100' } },
    { id: 'team-bol', user_id: DRIVER, doc_type: 'bol', load_id: L1, created_at: at(8) },
    { id: 'team-loose', user_id: DRIVER, doc_type: 'bol', load_id: null, created_at: at(7) },
    { id: 'rc-hidden', user_id: OWNER, doc_type: 'rate_confirmation', load_id: L1, created_at: at(6) },
    { id: 'rc-shown', user_id: OWNER, doc_type: 'rate_confirmation', load_id: L2, created_at: at(5) },
    { id: 'pod', user_id: DRIVER2, doc_type: 'pod', load_id: L2, created_at: at(4) },
    { id: 'receipt', user_id: OWNER, doc_type: 'receipt', load_id: L1, created_at: at(10) },
    { id: 'coi', user_id: OWNER, doc_type: 'coi', load_id: null, created_at: at(11) },
    { id: 'other-co', user_id: OTHER, doc_type: 'bol', load_id: XL, created_at: at(3) },
  ];
  const owner = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 50 });
  assert.deepEqual(owner.rows.map((r) => r.doc.id), ['own-loose', 'team-bol', 'rc-hidden', 'rc-shown', 'pod']);
  const driver = pageLoadVault({ docs, loads, role: 'driver', userId: DRIVER, ownerId: OWNER, limit: 50 });
  assert.deepEqual(driver.rows.map((r) => r.doc.id), ['team-bol', 'team-loose']);
  assert.equal(canSeeVaultDoc({ role: 'driver', userId: DRIVER, ownerId: OWNER, doc: docs[3], load: loads[0] }), false);
  const driver2 = pageLoadVault({ docs, loads, role: 'driver', userId: DRIVER2, ownerId: OWNER, limit: 50 });
  assert.deepEqual(driver2.rows.map((r) => r.doc.id), ['rc-shown', 'pod']);
  const byLoad = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { load: 'fake-100' }, limit: 50 });
  assert.deepEqual(byLoad.rows.map((r) => r.doc.id), ['own-loose', 'team-bol', 'rc-hidden']);
  const byBroker = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { broker: 'beta' }, limit: 50 });
  assert.deepEqual(byBroker.rows.map((r) => r.doc.id), ['rc-shown', 'pod']);
  const byType = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { type: 'pod' }, limit: 50 });
  assert.deepEqual(byType.rows.map((r) => r.doc.id), ['pod']);
  const byDate = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { from: '2026-01-01', to: '2026-01-01' }, limit: 50 });
  assert.equal(byDate.rows.length, 5);
  const page = pageLoadVault({ docs: owner.rows.map((r) => r.doc), loads, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 2 });
  assert.equal(page.rows.length, 2);
  assert.ok(page.nextCursor);
  const page2 = pageLoadVault({ docs: owner.rows.map((r) => r.doc), loads, role: 'owner', userId: OWNER, ownerId: OWNER, cursor: page.nextCursor, limit: 2 });
  assert.deepEqual(page2.rows.map((r) => r.doc.id), ['rc-hidden', 'rc-shown']);
});

function members() {
  return [DRIVER, DRIVER2].map((user_id) => ({ user_id, 'company_profiles.owner_id': OWNER }));
}

test('vault query pages on the server and a driver does not see another driver’s load', async () => {
  const docs = Array.from({ length: 25 }, (_, i) => ({
    id: `bol-${String(i + 1).padStart(2, '0')}`, user_id: DRIVER, doc_type: 'bol', load_id: L1, file_path: `${DRIVER}/b.pdf`, original_filename: `b${i}.pdf`, created_at: at(i + 1),
  }));
  docs.push(
    { id: 'loose-team', user_id: DRIVER, doc_type: 'bol', load_id: null, file_path: `${DRIVER}/loose.pdf`, original_filename: 'loose.pdf', created_at: at(40) },
    { id: 'receipt', user_id: OWNER, doc_type: 'receipt', load_id: L1, file_path: `${OWNER}/r.pdf`, original_filename: 'r.pdf', created_at: at(41) },
    { id: 'pod-2', user_id: DRIVER2, doc_type: 'pod', load_id: L2, file_path: `${DRIVER2}/p.pdf`, original_filename: 'p.pdf', created_at: at(30) },
    { id: 'rc-1', user_id: OWNER, doc_type: 'rate_confirmation', load_id: L1, file_path: `${OWNER}/rc.pdf`, original_filename: 'rc.pdf', created_at: at(31), ai_extracted_data: { broker_name: 'Acme (FAKE)', load_number: 'FAKE-100' } },
  );
  const tables = {
    company_members: members(),
    loads: [load(L1), load(L2, { broker_name: 'Beta (FAKE)', broker_load_number: 'FAKE-200', assigned_driver_user_id: DRIVER2, show_rate_to_driver: true })],
    documents: docs,
  };
  const svc = fakeSupabase({ tables });
  const first = await fetchVaultPage(svc, { ownerId: OWNER, role: 'owner', userId: OWNER, limit: 20 });
  assert.equal(first.rows.length, 20);
  assert.ok(first.nextCursor);
  assert.equal(first.rows.some((r) => r.doc.id === 'receipt'), false);
  assert.equal(first.rows.some((r) => r.doc.id === 'loose-team'), false);
  const second = await fetchVaultPage(svc, { ownerId: OWNER, role: 'owner', userId: OWNER, cursor: first.nextCursor, limit: 20 });
  const ids = [...first.rows, ...second.rows].map((r) => r.doc.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(second.nextCursor, null);
  assert.ok(ids.includes('pod-2'));
  assert.ok(ids.includes('rc-1'));
  const asDriver = await fetchVaultPage(svc, { ownerId: OWNER, role: 'driver', userId: DRIVER, limit: 50 });
  const driverIds = asDriver.rows.map((r) => r.doc.id);
  assert.equal(driverIds.includes('pod-2'), false);
  assert.equal(driverIds.includes('rc-1'), false);
  assert.ok(driverIds.includes('bol-01'));
  const found = await fetchVaultPage(svc, { ownerId: OWNER, role: 'owner', userId: OWNER, filters: { broker: 'Beta', type: 'pod' }, limit: 20 });
  assert.deepEqual(found.rows.map((r) => r.doc.id), ['pod-2']);
});

test('Load more returns the next page when there are more than 20 documents', async () => {
  const docs = Array.from({ length: 23 }, (_, i) => ({
    id: `bol-${String(i + 1).padStart(2, '0')}`, user_id: OWNER, doc_type: 'bol', load_id: L1,
    file_path: `${OWNER}/b.pdf`, original_filename: `b${i}.pdf`, created_at: at(i + 1),
  }));
  const tables = { company_members: members(), loads: [load(L1)], documents: docs, company_profiles: [{ id: 'p1', owner_id: OWNER }] };
  const req = (url) => new Request(url, { headers: { authorization: 'Bearer t' } });
  const firstRes = await VAULT.GET(req('http://x/api/documents/vault'), { deps: ctx('owner', OWNER, tables) });
  const first = await firstRes.json();
  assert.equal(firstRes.status, 200);
  assert.equal(first.documents.length, 20);
  assert.equal(first.documents[0].id, 'bol-23');
  assert.equal(first.documents[19].id, 'bol-04');
  assert.ok(first.nextCursor);
  const moreRes = await VAULT.GET(req(`http://x/api/documents/vault?cursor=${encodeURIComponent(first.nextCursor)}`), { deps: ctx('owner', OWNER, tables) });
  const more = await moreRes.json();
  assert.equal(more.documents.length, 3);
  assert.deepEqual(more.documents.map((d) => d.id), ['bol-03', 'bol-02', 'bol-01']);
  assert.equal(more.nextCursor, null);
  const ids = [...first.documents, ...more.documents].map((d) => d.id);
  assert.equal(new Set(ids).size, 23);
  const vaultPage = read('../../app/documents/vault/page.js');
  assert.match(vaultPage, /data-testid="load-more"/);
  assert.match(vaultPage, /load\(filters, cursor, true\)/);
});

test('a reversed vault date range shows an error and does not query', async () => {
  assert.equal(reversedDateRange({ from: '2026-12-01', to: '2026-01-01' }), true);
  assert.equal(reversedDateRange({ from: '2026-01-01', to: '2026-01-01' }), false);
  assert.equal(DATE_RANGE_ERROR, 'From date must be on or before To date');
  const docs = [{ id: 'bol', user_id: OWNER, doc_type: 'bol', load_id: L1, file_path: `${OWNER}/b.pdf`, original_filename: 'b.pdf', created_at: at(1) }];
  const filtered = pageLoadVault({ docs, loads: [load(L1)], role: 'owner', userId: OWNER, ownerId: OWNER, filters: { from: '2026-12-01', to: '2026-01-01' }, limit: 50 });
  assert.equal(filtered.rows.length, 0);
  const tables = { company_members: members(), loads: [load(L1)], documents: docs, company_profiles: [{ id: 'p1', owner_id: OWNER }] };
  const deps = ctx('owner', OWNER, tables);
  const skipped = await fetchVaultPage(deps.sb, { ownerId: OWNER, role: 'owner', userId: OWNER, filters: { from: '2026-12-01', to: '2026-01-01' } });
  assert.equal(skipped.rows.length, 0);
  assert.equal(skipped.dateError, DATE_RANGE_ERROR);
  assert.equal(deps.sb.calls.some((c) => c.t === 'documents'), false);
  const res = await VAULT.GET(new Request('http://x/api/documents/vault?from=2026-12-01&to=2026-01-01', { headers: { authorization: 'Bearer t' } }), { deps });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.documents, []);
  assert.equal(body.nextCursor, null);
  assert.equal(body.dateError, DATE_RANGE_ERROR);
  assert.equal(deps.sb.calls.some((c) => c.t === 'documents'), false);
  const vaultPage = read('../../app/documents/vault/page.js');
  const searchFn = vaultPage.slice(vaultPage.indexOf('function search'), vaultPage.indexOf('useEffect(() =>'));
  assert.ok(searchFn.indexOf('reversedDateRange') < searchFn.indexOf('load('));
  assert.match(vaultPage, /data-testid="vault-date-error"/);
  assert.match(vaultPage, /setDateError\(DATE_RANGE_ERROR\)/);
});

test('team inbox is the last 7 days, capped, and a driver only sees assigned loads', async () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const recent = Array.from({ length: 12 }, (_, i) => ({
    id: `t${String(i).padStart(2, '0')}`, user_id: DRIVER, doc_type: 'bol', load_id: L1, file_path: `${DRIVER}/t.pdf`, original_filename: `t${i}.pdf`,
    created_at: new Date(Date.parse('2026-10-22T00:00:00Z') + i * 3600e3).toISOString(),
  }));
  const tables = {
    company_members: members(),
    loads: [load(L1), load(L2, { assigned_driver_user_id: DRIVER2, show_rate_to_driver: true, broker_name: 'Beta (FAKE)', broker_load_number: 'FAKE-200' })],
    documents: [
      ...recent,
      { id: 'old', user_id: DRIVER, doc_type: 'bol', load_id: L1, file_path: `${DRIVER}/old.pdf`, original_filename: 'old.pdf', created_at: '2026-09-01T00:00:00Z' },
      { id: 'other-load', user_id: DRIVER2, doc_type: 'pod', load_id: L2, file_path: `${DRIVER2}/p.pdf`, original_filename: 'p.pdf', created_at: '2026-10-22T08:00:00Z' },
    ],
  };
  const office = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: OWNER, now });
  assert.equal(office.documents.length, 10);
  assert.equal(office.documents.some((d) => d.id === 'old'), false);
  assert.equal(office.documents[0].id, 't11');
  const driver = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'driver', userId: DRIVER, now });
  assert.equal(driver.documents.some((d) => d.id === 'other-load'), false);
  assert.ok(driver.documents.some((d) => d.id === 't11'));
});

test('driver vault groups files per driver and a driver sees only their own', () => {
  const drivers = [
    { id: P1, name: 'Pat Driver (FAKE)', auth_user_id: DRIVER, active: true, cdl_expiry: '2027-03-01', med_card_expiry: null },
    { id: P2, name: 'Sam Driver (FAKE)', auth_user_id: DRIVER2, active: true, cdl_expiry: null, med_card_expiry: '2026-11-02' },
  ];
  const documents = [
    { id: 'cdl-pat', user_id: OWNER, doc_type: 'cdl', file_path: `${OWNER}/checklist/cdl/${P1}/cdl.pdf`, original_filename: 'cdl.pdf', created_at: at(2) },
    { id: 'med-sam', user_id: OWNER, doc_type: 'medical_card', file_path: `${OWNER}/checklist/medical_card/${P2}/med.jpg`, original_filename: 'med.jpg', created_at: at(3) },
    { id: 'drug-pat', user_id: OWNER, doc_type: 'drug_test', file_path: `${OWNER}/checklist/drug_test/${P1}/drug.pdf`, original_filename: 'drug.pdf', created_at: at(4) },
    { id: 'mvr', user_id: OWNER, doc_type: 'other:MVR', file_path: `${OWNER}/checklist/note/company/mvr.pdf`, original_filename: 'mvr.pdf', created_at: at(1) },
  ];
  const statuses = [{ document_id: 'mvr', driver_id: P1, item_key: 'annual_mvr' }];
  const office = groupDriverVault({ drivers, documents, statuses, role: 'owner', userId: OWNER });
  const pat = office.groups.find((g) => g.driver.id === P1);
  assert.deepEqual(pat.files.map((f) => f.id).sort(), ['cdl-pat', 'drug-pat', 'mvr']);
  assert.deepEqual(office.groups.find((g) => g.driver.id === P2).files.map((f) => f.id), ['med-sam']);
  const mine = groupDriverVault({ drivers, documents, statuses, role: 'driver', userId: DRIVER });
  assert.equal(mine.groups.length, 1);
  assert.equal(mine.groups[0].driver.name, 'Pat Driver (FAKE)');
  assert.equal(mine.unassigned.length, 0);
  assert.equal(mine.groups[0].files.some((f) => f.id === 'med-sam'), false);
  const unlinked = groupDriverVault({ drivers: [], documents, statuses: [], role: 'driver', userId: DRIVER });
  assert.equal(unlinked.groups.length, 0);
});

function ctx(role, userId, tables) {
  const svc = fakeSupabase({ tables, user: { id: userId }, role });
  svc.storage.from = () => ({ createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://fake.invalid/${p}` })) }) });
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  return { mkUserClient: () => uc, sb: svc };
}

test('vault routes: sign-in required, driver file route hides the other driver', async () => {
  const tables = {
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    company_members: members(),
    drivers: [
      { id: P1, user_id: OWNER, name: 'Pat Driver (FAKE)', auth_user_id: DRIVER, active: true },
      { id: P2, user_id: OWNER, name: 'Sam Driver (FAKE)', auth_user_id: DRIVER2, active: true },
    ],
    documents: [
      { id: 'cdl-pat', user_id: OWNER, doc_type: 'cdl', file_path: `${OWNER}/checklist/cdl/${P1}/cdl.pdf`, original_filename: 'cdl.pdf', created_at: at(2) },
      { id: 'med-sam', user_id: OWNER, doc_type: 'medical_card', file_path: `${OWNER}/checklist/medical_card/${P2}/med.jpg`, original_filename: 'med.jpg', created_at: at(3) },
    ],
    loads: [load(L1)],
  };
  const noAuth = await VAULT.GET(new Request('http://x/api/documents/vault'), { deps: ctx('owner', OWNER, tables) });
  assert.equal(noAuth.status, 401);
  const req = (url) => new Request(url, { headers: { authorization: 'Bearer t' } });
  const asDriver = await DRIVERS.GET(req('http://x/api/documents/drivers'), { deps: ctx('driver', DRIVER, tables) });
  const body = await asDriver.json();
  assert.equal(asDriver.status, 200);
  assert.deepEqual(body.drivers.map((d) => d.name), ['Pat Driver (FAKE)']);
  assert.deepEqual(body.drivers[0].files.map((f) => f.id), ['cdl-pat']);
  assert.equal(JSON.stringify(body).includes('Sam Driver'), false);
  const inbox = await TEAM.GET(req('http://x/api/documents/team?inbox=1'), { deps: ctx('owner', OWNER, { ...tables, documents: [
    { id: 'new-bol', user_id: DRIVER, doc_type: 'bol', load_id: L1, file_path: `${DRIVER}/n.pdf`, original_filename: 'n.pdf', created_at: new Date().toISOString() },
    { id: 'old-bol', user_id: DRIVER, doc_type: 'bol', load_id: L1, file_path: `${DRIVER}/o.pdf`, original_filename: 'o.pdf', created_at: '2020-01-01T00:00:00Z' },
  ] }) });
  const team = await inbox.json();
  assert.deepEqual(team.documents.map((d) => d.id), ['new-bol']);
});

test('tile counts are head counts for visible paperwork, not a full list', async () => {
  const tables = {
    company_members: members(),
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    loads: [load(L1), load(L2, { assigned_driver_user_id: DRIVER2, show_rate_to_driver: false, broker_load_number: 'FAKE-200' })],
    drivers: [{ id: P1, user_id: OWNER, name: 'Pat Driver (FAKE)', auth_user_id: DRIVER, active: true }],
    documents: [
      { id: 'b1', user_id: DRIVER, doc_type: 'bol', load_id: L1, created_at: at(1) },
      { id: 'b2', user_id: OWNER, doc_type: 'bol', load_id: null, created_at: at(2) },
      { id: 'loose', user_id: DRIVER, doc_type: 'bol', load_id: null, created_at: at(3) },
      { id: 'rc', user_id: OWNER, doc_type: 'receipt', load_id: L1, created_at: at(4) },
      { id: 'w9', user_id: OWNER, doc_type: 'w9', load_id: null, created_at: at(5) },
      { id: 'coi', user_id: OWNER, doc_type: 'coi', load_id: null, created_at: at(6) },
      { id: 'cdl', user_id: OWNER, doc_type: 'cdl', file_path: `${OWNER}/checklist/cdl/${P1}/cdl.pdf`, created_at: at(7) },
    ],
  };
  const counts = await vaultTileCounts(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: OWNER, profileId: 'p1' });
  assert.equal(counts.loadDocs, 2);
  assert.equal(counts.companyDocs, 2);
  assert.equal(counts.driverDocs, 1);
  const driverCounts = await vaultTileCounts(fakeSupabase({ tables }), { ownerId: OWNER, role: 'driver', userId: DRIVER2, profileId: 'p1' });
  assert.equal(driverCounts.driverDocs, 0);
  assert.equal(driverCounts.loadDocs, 0);
});

test('docs tab source: limited inbox, vault tiles, maintenance flag, indexes only', () => {
  const page = read('../../app/documents/page.js');
  const q = page.slice(page.indexOf('const q = (cols) =>'), page.indexOf('let { data, error } = await q('));
  assert.match(q, /\.gte\('created_at'/);
  assert.match(q, /\.limit\(/);
  assert.doesNotMatch(q, /user_id/);
  assert.match(page, /mergeInboxDocs/);
  assert.match(page, /<TeamDocsList [^>]*inbox/);
  assert.match(page, /readInboxOpen/);
  assert.match(page, /<VaultTiles supabase=\{supabase\} refreshKey=\{vaultTick\} \/>/);
  assert.match(page, /data-testid="vault-note"/);
  const uploadFn = page.slice(page.indexOf('async function uploadRateCon'), page.indexOf('async function openScanner'));
  assert.ok(uploadFn.indexOf('await loadDocs()') < uploadFn.indexOf('setVaultTick'));
  const removeFn = page.slice(page.indexOf('async function removeDoc'), page.indexOf('async function loadDocs'));
  assert.ok(removeFn.indexOf('if (!r.ok)') < removeFn.indexOf('setVaultTick'));
  assert.match(page, /onDeleted=\{\(id\) => \{ setDocs\(\(list\) => list\.filter\(\(x\) => x\.id !== id\)\); setVaultTick\(\(n\) => n \+ 1\); \}\}/);
  assert.match(read('../../app/components/VaultTiles.js'), /\[supabase, refreshKey\]/);
  assert.match(page, /tap: \{ display: 'inline-flex', alignItems: 'center', minHeight: 44 \}/);
  assert.match(page, /href="\/documents\/checklist" style=\{s\.tap\}>Setup checklist/);
  assert.match(page, /href="\/company#company-documents" style=\{\{ \.\.\.s\.tap, color: 'var\(--primary\)' \}\}>Company → Company documents/);
  for (const file of ['../../app/documents/vault/page.js', '../../app/documents/drivers/page.js']) {
    const src = read(file);
    assert.match(src, /const tap = \{[^}]*minHeight: 44/);
    assert.match(src, /<Link href="\/documents" style=\{tap\}>Documents<\/Link>/);
  }
  assert.match(page, /setDocs\(\(data \|\| \[\]\)\.filter\(isDocumentsTabDoc\)\)/);
  const tiles = read('../../app/components/VaultTiles.js');
  const body = tiles.slice(tiles.indexOf('export default'));
  assert.ok(body.indexOf('if (MAINTENANCE_VAULT_ENABLED)') < body.indexOf('fetchMaintenanceCount'));
  assert.match(read('../../app/lib/maintenanceVault.js'), /TODO/);
  assert.doesNotMatch(read('../../app/api/documents/vault-counts/route.js'), /maintenance_vault_count/);
  assert.doesNotMatch(read('../../app/lib/vaultCounts.js'), /maintenance_vault_count/);
  const sql = read('../../supabase/migrations/20261023120000_documents_vault_indexes.sql').toLowerCase();
  assert.match(sql, /create index if not exists documents_user_created_idx/);
  assert.match(sql, /create index if not exists loads_owner_broker_name_idx/);
  assert.doesNotMatch(sql, /create policy|drop policy|alter policy|enable row level security|grant /);
  const ui = [page, read('../../app/documents/vault/page.js'), read('../../app/documents/drivers/page.js'), tiles]
    .map((src) => src.replace(/\/\/.*$/gm, ''))
    .join('\n');
  assert.doesNotMatch(ui, /\b(AI|bot|robot)\b/i);
});
