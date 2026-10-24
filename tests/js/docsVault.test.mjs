// Docs tab inbox + vaults. Fake rows only. No live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { selectNeedsAttention, needsAttention, attentionLabel, fetchNeedsAttention, readInboxOpen, writeInboxOpen, INBOX_OPEN_KEY, INBOX_ATTENTION_CAP } from '../../app/lib/docsInbox.js';
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

test('needs attention is unreviewed rate cons and unassigned uploads only', () => {
  const driverId = '00000000-0000-4000-8000-0000000000d1';
  const rows = [
    { id: 'w-old', source: 'email', load_id: null, doc_type: 'rate_confirmation', created_at: '2020-01-01T00:00:00Z' },
    { id: 'w-new', source: 'email', load_id: null, doc_type: 'rate_confirmation', created_at: '2026-10-22T00:00:00Z' },
    { id: 'not', source: 'email', load_id: null, doc_type: 'rate_confirmation', extraction_error: 'not_ratecon', created_at: '2026-10-22T00:00:00Z' },
    { id: 'linked', source: 'email', load_id: L1, doc_type: 'rate_confirmation', created_at: '2026-10-22T00:00:00Z' },
    { id: 'loose-bol', source: 'upload', load_id: null, truck_id: null, doc_type: 'bol', file_path: `${OWNER}/bol.pdf`, created_at: at(3) },
    { id: 'on-load', source: 'upload', load_id: L1, doc_type: 'bol', file_path: `${OWNER}/on.pdf`, created_at: at(4) },
    { id: 'on-truck', source: 'upload', load_id: null, truck_id: 'truck-1', doc_type: 'scale_ticket', created_at: at(5) },
    { id: 'maint', source: 'upload', load_id: null, service_record_id: 'svc-1', doc_type: 'maintenance_receipt', created_at: at(6) },
    { id: 'cdl', source: 'upload', load_id: null, doc_type: 'cdl', file_path: `${OWNER}/checklist/cdl/${driverId}/cdl.pdf`, created_at: at(7) },
    { id: 'w9', source: 'upload', load_id: null, doc_type: 'w9', file_path: `${OWNER}/company/vault-w9.pdf`, created_at: at(8) },
    { id: 'receipt', source: 'upload', load_id: null, doc_type: 'receipt', created_at: at(9) },
    { id: 'ticketed', source: 'upload', load_id: null, truck_id: null, doc_type: 'scale_ticket', file_path: `${OWNER}/t.jpg`, created_at: at(2) },
    { id: 'confirmed', source: 'upload', load_id: null, doc_type: 'scale_ticket', file_path: `${OWNER}/c.jpg`, created_at: at(1) },
  ];
  assert.equal(isEmailDraft(rows[2]), false);
  assert.equal(needsAttention(rows[2]), false);
  const tickets = [
    { document_id: 'ticketed', truck_id: 'truck-1', load_id: L1, confirmed: false },
    { document_id: 'confirmed', confirmed: true },
  ];
  const picked = selectNeedsAttention(rows, tickets);
  assert.deepEqual(picked.map((d) => d.id), ['w-old', 'w-new', 'loose-bol']);
  const many = Array.from({ length: INBOX_ATTENTION_CAP + 5 }, (_, i) => ({ id: `u${i}`, source: 'upload', doc_type: 'bol', load_id: null, file_path: `${OWNER}/u${i}.pdf`, created_at: at(i + 1) }));
  assert.equal(selectNeedsAttention(many).length, INBOX_ATTENTION_CAP + 5);
  assert.equal(attentionLabel(0), 'Nothing waiting for review');
  assert.equal(attentionLabel(1), '1 waiting for review');
  assert.equal(attentionLabel(4), '4 waiting for review');
});

test('mine fetch drops filed rows and falls back when a newer column is missing', async () => {
  const rows = [
    { id: 'draft', user_id: OWNER, source: 'email', load_id: null, truck_id: null, doc_type: 'rate_confirmation', file_path: `${OWNER}/a.pdf`, created_at: at(2) },
    { id: 'bol', user_id: OWNER, source: 'upload', load_id: null, truck_id: null, doc_type: 'bol', file_path: `${OWNER}/b.pdf`, created_at: at(1) },
    { id: 'filed', user_id: OWNER, source: 'upload', load_id: L1, truck_id: null, doc_type: 'bol', file_path: `${OWNER}/c.pdf`, created_at: at(3) },
  ];
  const ok = await fetchNeedsAttention(fakeSupabase({ tables: { documents: rows, scale_tickets: [] } }));
  assert.deepEqual(ok.documents.map((d) => d.id), ['draft', 'bol']);
  assert.equal(ok.more, false);
  let calls = 0;
  const chain = (result) => {
    const api = { select: () => api, is: () => api, not: () => api, order: () => api, limit: () => api, in: () => api, then: (res, rej) => Promise.resolve(result()).then(res, rej) };
    return api;
  };
  const fallback = {
    from(table) {
      calls += 1;
      if (table === 'documents' && calls === 1) return chain(() => ({ data: null, error: { code: '42703' } }));
      if (table === 'documents') return chain(() => ({ data: [rows[1]], error: null }));
      return chain(() => ({ data: [], error: null }));
    },
  };
  const again = await fetchNeedsAttention(fallback);
  assert.equal(again.error, null);
  assert.deepEqual(again.documents.map((d) => d.id), ['bol']);
  assert.ok(calls >= 2);
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
  assert.deepEqual(owner.rows.map((r) => r.doc.id), ['team-bol', 'rc-hidden', 'rc-shown', 'pod']);
  assert.equal(owner.rows.some((r) => r.doc.id === 'own-loose'), false);
  const driver = pageLoadVault({ docs, loads, role: 'driver', userId: DRIVER, ownerId: OWNER, limit: 50 });
  assert.deepEqual(driver.rows.map((r) => r.doc.id), ['team-bol']);
  assert.equal(canSeeVaultDoc({ role: 'driver', userId: DRIVER, ownerId: OWNER, doc: docs[3], load: loads[0] }), false);
  const driver2 = pageLoadVault({ docs, loads, role: 'driver', userId: DRIVER2, ownerId: OWNER, limit: 50 });
  assert.deepEqual(driver2.rows.map((r) => r.doc.id), ['rc-shown', 'pod']);
  const byLoad = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { load: 'fake-100' }, limit: 50 });
  assert.deepEqual(byLoad.rows.map((r) => r.doc.id), ['team-bol', 'rc-hidden']);
  const byBroker = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { broker: 'beta' }, limit: 50 });
  assert.deepEqual(byBroker.rows.map((r) => r.doc.id), ['rc-shown', 'pod']);
  const byType = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { type: 'pod' }, limit: 50 });
  assert.deepEqual(byType.rows.map((r) => r.doc.id), ['pod']);
  const byDate = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, filters: { from: '2026-01-01', to: '2026-01-01' }, limit: 50 });
  assert.equal(byDate.rows.length, 4);
  const page = pageLoadVault({ docs: owner.rows.map((r) => r.doc), loads, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 2 });
  assert.equal(page.rows.length, 2);
  assert.ok(page.nextCursor);
  const page2 = pageLoadVault({ docs: owner.rows.map((r) => r.doc), loads, role: 'owner', userId: OWNER, ownerId: OWNER, cursor: page.nextCursor, limit: 2 });
  assert.deepEqual(page2.rows.map((r) => r.doc.id), ['rc-shown', 'pod']);
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

test('team needs-attention is unassigned teammate uploads, not recent linked files', async () => {
  const loose = Array.from({ length: 3 }, (_, i) => ({
    id: `loose-${i}`, user_id: DRIVER, doc_type: 'bol', load_id: null, truck_id: null, source: 'upload',
    file_path: `${DRIVER}/loose-${i}.pdf`, original_filename: `loose-${i}.pdf`, created_at: at(30 + i),
  }));
  const tables = {
    company_members: members(),
    loads: [load(L1), load(L2, { assigned_driver_user_id: DRIVER2, show_rate_to_driver: true, broker_name: 'Beta (FAKE)', broker_load_number: 'FAKE-200' })],
    documents: [
      ...loose,
      { id: 'linked', user_id: DRIVER, doc_type: 'bol', load_id: L1, source: 'upload', file_path: `${DRIVER}/t.pdf`, original_filename: 't.pdf', created_at: at(40) },
      { id: 'old-loose', user_id: DRIVER2, doc_type: 'pod', load_id: null, truck_id: null, source: 'upload', file_path: `${DRIVER2}/old.pdf`, original_filename: 'old.pdf', created_at: '2020-01-01T00:00:00Z' },
      { id: 'mine', user_id: OWNER, doc_type: 'bol', load_id: null, truck_id: null, source: 'upload', file_path: `${OWNER}/mine.pdf`, original_filename: 'mine.pdf', created_at: at(50) },
      { id: 'email', user_id: DRIVER, doc_type: 'rate_confirmation', load_id: null, source: 'email', file_path: `${DRIVER}/rc.pdf`, original_filename: 'rc.pdf', created_at: at(51) },
      { id: 'cdl', user_id: DRIVER, doc_type: 'cdl', load_id: null, source: 'upload', file_path: `${OWNER}/checklist/cdl/${P1}/cdl.pdf`, original_filename: 'cdl.pdf', created_at: at(52) },
      { id: 'ticketed', user_id: DRIVER, doc_type: 'scale_ticket', load_id: null, truck_id: null, source: 'upload', file_path: `${DRIVER}/sc.jpg`, original_filename: 'sc.jpg', created_at: at(53) },
    ],
    scale_tickets: [{ id: 'tk', user_id: OWNER, document_id: 'ticketed', truck_id: 'truck-1', confirmed: false }],
  };
  const office = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: OWNER });
  assert.deepEqual(office.documents.map((d) => d.id), ['loose-2', 'loose-1', 'loose-0', 'old-loose']);
  const driver = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'driver', userId: DRIVER });
  assert.deepEqual(driver.documents, []);
  const asDriver = await selectInboxTeamDocs(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: DRIVER });
  assert.equal(asDriver.documents.some((d) => d.id === 'mine'), true);
  assert.equal(asDriver.documents.some((d) => d.id.startsWith('loose-')), false);
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
    { id: 'loose-bol', user_id: DRIVER, doc_type: 'bol', load_id: null, truck_id: null, source: 'upload', file_path: `${DRIVER}/n.pdf`, original_filename: 'n.pdf', created_at: '2026-10-02T00:00:00Z' },
    { id: 'linked-bol', user_id: DRIVER, doc_type: 'bol', load_id: L1, source: 'upload', file_path: `${DRIVER}/o.pdf`, original_filename: 'o.pdf', created_at: '2026-10-03T00:00:00Z' },
  ] }) });
  const team = await inbox.json();
  assert.deepEqual(team.documents.map((d) => d.id), ['loose-bol']);
});

test('vault list and tile count omit docs that still need attention', async () => {
  const draft = { id: 'draft', user_id: OWNER, source: 'email', doc_type: 'rate_confirmation', load_id: null, truck_id: null, file_path: `${OWNER}/rc.pdf`, original_filename: 'rc.pdf', created_at: at(9) };
  const filed = { id: 'filed', user_id: OWNER, source: 'email', doc_type: 'rate_confirmation', load_id: L1, file_path: `${OWNER}/filed.pdf`, original_filename: 'filed.pdf', created_at: at(8) };
  const dismissed = { id: 'dismissed', user_id: OWNER, source: 'email', doc_type: 'rate_confirmation', load_id: null, extraction_error: 'not_ratecon', ai_extracted_data: null, file_path: `${OWNER}/no.pdf`, original_filename: 'no.pdf', created_at: at(7) };
  const loose = { id: 'loose', user_id: OWNER, source: 'upload', doc_type: 'bol', load_id: null, truck_id: null, file_path: `${OWNER}/bol.pdf`, original_filename: 'bol.pdf', created_at: at(6) };
  const docs = [draft, filed, dismissed, loose];
  const loads = [load(L1)];
  const page = pageLoadVault({ docs, loads, role: 'owner', userId: OWNER, ownerId: OWNER, limit: 20 });
  assert.deepEqual(page.rows.map((r) => r.doc.id), ['filed', 'dismissed']);
  const tables = {
    company_members: members(),
    company_profiles: [{ id: 'p1', owner_id: OWNER }],
    loads,
    drivers: [],
    documents: docs,
    scale_tickets: [],
  };
  const counts = await vaultTileCounts(fakeSupabase({ tables }), { ownerId: OWNER, role: 'owner', userId: OWNER, profileId: 'p1' });
  assert.equal(counts.loadDocs, page.rows.length);
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
  assert.equal(counts.loadDocs, 1);
  assert.equal(counts.companyDocs, 2);
  assert.equal(counts.driverDocs, 1);
  const driverCounts = await vaultTileCounts(fakeSupabase({ tables }), { ownerId: OWNER, role: 'driver', userId: DRIVER2, profileId: 'p1' });
  assert.equal(driverCounts.driverDocs, 0);
  assert.equal(driverCounts.loadDocs, 0);
});

test('docs tab source: needs attention only, vault tiles, maintenance flag, indexes only', () => {
  const page = read('../../app/documents/page.js');
  const inbox = read('../../app/lib/docsInbox.js');
  assert.match(inbox, /\.is\('load_id', null\)/);
  assert.match(inbox, /\.is\('truck_id', null\)/);
  assert.match(inbox, /\.limit\(/);
  const queryFn = inbox.slice(inbox.indexOf('function attentionQuery'), inbox.indexOf('export async function fetchNeedsAttention'));
  assert.doesNotMatch(queryFn, /\.eq\('user_id'/);
  assert.doesNotMatch(page, /INBOX_RECENT|mergeInboxDocs|Recent uploads|Recent load paperwork|Nothing from the last 7 days/);
  assert.match(page, /fetchNeedsAttention/);
  assert.match(page, /data-testid="needs-attention-count"/);
  assert.match(page, /data-testid="needs-attention-empty"/);
  assert.match(page, /showHide: \{[^}]*minHeight: 44/);
  assert.match(page, /minWidth: 112/);
  assert.match(page, /publishAttentionCount/);
  assert.match(read('../../app/components/AppNav.js'), /data-testid="docs-nav-count"/);
  assert.match(read('../../app/components/AppNav.js'), /attention > 0 &&/);
  assert.match(page, /<TeamDocsList [^>]*inbox/);
  assert.match(page, /readInboxOpen/);
  assert.match(page, /<VaultTiles supabase=\{supabase\} refreshKey=\{vaultTick\} \/>/);
  assert.match(page, /data-testid="vault-note"/);
  const uploadFn = page.slice(page.indexOf('async function uploadRateCon'), page.indexOf('async function openScanner'));
  assert.ok(uploadFn.indexOf('await loadDocs()') < uploadFn.indexOf('setVaultTick'));
  const removeFn = page.slice(page.indexOf('async function removeDoc'), page.indexOf('async function loadDocs'));
  assert.ok(removeFn.indexOf('if (!r.ok)') < removeFn.indexOf('setVaultTick'));
  assert.match(page, /onDeleted=\{\(id\) => \{ commitDocs\(\(list\) => list\.filter\(\(x\) => x\.id !== id\)\); setVaultTick\(\(n\) => n \+ 1\); \}\}/);
  assert.match(read('../../app/components/VaultTiles.js'), /\[supabase, refreshKey\]/);
  assert.match(page, /tap: \{ display: 'inline-flex', alignItems: 'center', minHeight: 44 \}/);
  assert.match(page, /href="\/documents\/checklist" style=\{s\.tap\}>Setup checklist/);
  assert.match(page, /href="\/company#company-documents" style=\{\{ \.\.\.s\.tap, color: 'var\(--primary\)' \}\}>Company → Company documents/);
  for (const file of ['../../app/documents/vault/page.js', '../../app/documents/drivers/page.js']) {
    const src = read(file);
    assert.match(src, /const tap = \{[^}]*minHeight: 44/);
    assert.match(src, /<Link href="\/documents" style=\{tap\}>Documents<\/Link>/);
  }
  assert.match(page, /commitDocs\(\(got\.documents \|\| \[\]\)\.filter\(isDocumentsTabDoc\)/);
  assert.match(page, /const attentionCount = view_ === 'team' \? teamCount : docs\.length/);
  const uploadFn2 = page.slice(page.indexOf('async function uploadRateCon'), page.indexOf('async function openScanner'));
  assert.ok(uploadFn2.indexOf('commitDocs((list) => [row,') < uploadFn2.indexOf('await loadDocs()'));
  const teamList = read('../../app/components/TeamDocsList.js');
  assert.match(teamList, /onCount\?\.\(next\.length\)/);
  assert.doesNotMatch(teamList, /useEffect\(\(\) => \{ if \(state === 'ready'\) onCount/);
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
