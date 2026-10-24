// Maintenance vault (PR 3): scan normalization, service-type mapping, form prefill, save args. Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapServiceType, normalizeShopInvoice, invoiceToForm, saveArgs, searchWords } from '../../app/lib/vaultScan.js';
import { DOC_TYPES } from '../../app/lib/ai-extract.js';
import { SERVICE_TYPES } from '../../app/lib/maintenance.js';
import { DOCUMENTS_SCAN_TYPE_IDS, SCAN_DOC_TYPES } from '../../app/lib/docTypes.js';
import { maintenanceVaultHref } from '../../app/lib/maintenanceVault.js';

test('mapServiceType: keeps a valid type, maps descriptions, else other', () => {
  assert.equal(mapServiceType('anything', 'brakes'), 'brakes');
  assert.equal(mapServiceType('Change oil & filter 15W-40', 'other'), 'oil_filter');
  assert.equal(mapServiceType('PM-A service'), 'oil_filter');
  assert.equal(mapServiceType('Replace primary + secondary fuel filter'), 'fuel_filters');
  assert.equal(mapServiceType('Coolant filter'), 'coolant_filter');
  assert.equal(mapServiceType('Coolant flush, ELC'), 'coolant');
  assert.equal(mapServiceType('DEF dosing filter'), 'def_filter');
  assert.equal(mapServiceType('Air cleaner element'), 'air_filter');
  assert.equal(mapServiceType('Overhead adjustment'), 'valve_adjustment');
  assert.equal(mapServiceType('Rear end fluid'), 'differential');
  assert.equal(mapServiceType('Mount 2 steer tires'), 'tires');
  assert.equal(mapServiceType('Brake shoes and drums'), 'brakes');
  assert.equal(mapServiceType('Chassis lube'), 'grease');
  assert.equal(mapServiceType('Annual DOT inspection'), 'dot_annual');
  assert.equal(mapServiceType('Transmission service'), 'transmission');
  assert.equal(mapServiceType('Replace headlight bulb'), 'other');
  assert.equal(mapServiceType('', 'bogus'), 'other');
});

test('normalizeShopInvoice: cleans values, drops future dates, merges types', () => {
  const inv = normalizeShopInvoice({
    is_invoice: true, date: '2026-09-14', odometer: '401,250', vendor: '  TEST Joe\'s   Diesel ', total: '$1,234.567',
    services: [
      { description: 'Oil change', service_type: 'oil_filter', cost: 250 },
      { description: 'Oil filter', service_type: 'other', cost: '30.10' },
      { description: 'Wiper blades', service_type: 'other', cost: 20 },
      { description: 'Headlight', service_type: 'other', cost: null },
    ],
    text: 'INVOICE   4471\nOIL',
  }, { today: '2026-10-24' });
  assert.equal(inv.date, '2026-09-14');
  assert.equal(inv.odometer, 401250);
  assert.equal(inv.vendor, "TEST Joe's Diesel");
  assert.equal(inv.total, 1234.57);
  assert.deepEqual(inv.services, [{ type: 'oil_filter', label: null, cost: 280.1 }, { type: 'other', label: 'Wiper blades, Headlight', cost: 20 }]);
  assert.equal(inv.text, 'INVOICE 4471\nOIL');
  assert.equal(normalizeShopInvoice({ date: '2026-10-25' }, { today: '2026-10-24' }).date, null);
  assert.equal(normalizeShopInvoice({ date: '2026-02-30' }).date, null);
  assert.equal(normalizeShopInvoice({ odometer: -5, total: -1 }).odometer, null);
  assert.equal(normalizeShopInvoice(null).isInvoice, true);
  assert.equal(normalizeShopInvoice({ is_invoice: false }).isInvoice, false);
  assert.equal(normalizeShopInvoice({ text: 'x'.repeat(30000) }).text.length, 20000);
});

test('invoiceToForm: pre-fills the Log service form, keeps unread fields', () => {
  const base = { serviceDate: '2026-10-24', odometer: 400000, vendor: '', totalCost: '', notes: '', addToExpenses: true, loadId: '', entrySource: 'logged', checked: {}, costs: {}, otherLabel: '' };
  const f = invoiceToForm({ date: '2026-09-14', odometer: 401250, vendor: 'TEST Shop', total: 612.4, services: [{ type: 'oil_filter', cost: 250 }, { type: 'other', label: 'Wipers', cost: null }] }, base);
  assert.equal(f.serviceDate, '2026-09-14'); assert.equal(f.odometer, '401250'); assert.equal(f.vendor, 'TEST Shop'); assert.equal(f.totalCost, '612.40');
  assert.deepEqual(f.checked, { oil_filter: true, other: true }); assert.deepEqual(f.costs, { oil_filter: '250.00' }); assert.equal(f.otherLabel, 'Wipers');
  assert.equal(f.entrySource, 'logged'); assert.equal(f.addToExpenses, true);
  const g = invoiceToForm({ date: null, odometer: null, vendor: null, total: null, services: [] }, base);
  assert.equal(g.serviceDate, '2026-10-24'); assert.equal(g.odometer, 400000); assert.deepEqual(base.checked, {});
});

test('saveArgs: blanks to null, validates', () => {
  assert.deepEqual(saveArgs('d', { vendor: ' TEST ', date: '2026-09-14', total: '$1,200.5', odometer: '401,250', notes: '', text: 'abc', scanned: true }),
    { p_doc: 'd', p_vendor: 'TEST', p_date: '2026-09-14', p_total: 1200.5, p_odometer: 401250, p_notes: null, p_text: 'abc', p_scanned: true });
  assert.deepEqual(saveArgs('d', {}), { p_doc: 'd', p_vendor: null, p_date: null, p_total: null, p_odometer: null, p_notes: null, p_text: null, p_scanned: false });
  assert.throws(() => saveArgs('d', { date: '09/14/2026' }));
  assert.throws(() => saveArgs('d', { total: 'abc' }));
  assert.throws(() => saveArgs('d', { odometer: '12.5' }));
});

test('shop_invoice extraction entry uses the checklist service types', () => {
  const cfg = DOC_TYPES.shop_invoice;
  assert.ok(cfg && cfg.normalize && cfg.prompt);
  assert.deepEqual(cfg.schema.properties.services.items.properties.service_type.enum, SERVICE_TYPES.map(([k]) => k));
  assert.deepEqual(cfg.schema.required.slice().sort(), Object.keys(cfg.schema.properties).sort());
  assert.ok(!/\bAI\b|\bbot\b/i.test(JSON.stringify(SCAN_DOC_TYPES.find((t) => t.id === 'maintenance_doc'))));
});

test('vault doc type is not offered on the Documents tab; route contract', () => {
  assert.ok(SCAN_DOC_TYPES.some((t) => t.id === 'maintenance_doc'));
  assert.ok(!DOCUMENTS_SCAN_TYPE_IDS.includes('maintenance_doc'));
  assert.equal(maintenanceVaultHref('abc'), '/maintenance/vault?truck=abc');
  const page = readFileSync(new URL('../../app/maintenance/vault/page.js', import.meta.url), 'utf8');
  assert.match(page, /params\.get\('truck'\)/);
  assert.ok(!/\bAI\b|\bbot\b|robot|GPT|OpenAI/i.test(page.replace(/^\s*\/\/.*$/gm, '')), 'no AI / bot wording in UI');
  assert.deepEqual(searchWords('  Joe  9/14 '), ['joe', '9/14']);
});

test('migration: Casey contract and no prod-only statements', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261024000400_maintenance_vault.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.maintenance_vault_count\(\)\s+returns integer/);
  assert.ok(!/[^\x00-\x7F]/.test(sql));
  assert.ok(!/drop table|truncate|delete from public\.documents\s*;/i.test(sql));
});
