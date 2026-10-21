import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORIES, CHECKLIST_ITEMS, UNVERIFIED_KEYS, DRIVER_EQUIPMENT_KEYS, DRIVER_BINDER_KEYS, DRIVER_FILE_DOC_TYPES, itemByKey, answerApplies } from '../../app/lib/setupCatalog.js';
import { categoryForDocType, DOC_CATEGORY_NAMES } from '../../app/lib/docCategories.js';
import {
  nextBusinessDay, iftaDue, iftaNominal, mcs150Schedule, nextMcs150Due, form2290DueForFirstUse, ucrCycle, comingUp, homeComingUp, complianceEntries, daysBetween,
} from '../../app/lib/complianceCalendar.js';
import {
  buildChecklist, summarize, matchesFilter, cycleState, equipmentCurrent, setupEntry, NEW_COMPANY_MS, driverFileRows, roadsideForTruck, modelFromPayload,
  expiryEntries, applyDriverNames, showUndo,
} from '../../app/lib/setupProgress.js';
import { buildDriverFilePdf } from '../../app/lib/driverFilePdf.js';

const NAMES = [
  'Company & Authority', 'Insurance', 'Taxes & Fuel Tax', 'Drug & Alcohol', 'Driver Files', 'Truck & Trailer',
  'Permits', 'In-Cab Binder', 'Truck Equipment', 'Loads & Paperwork', 'Billing & Factoring', 'Hazmat (only if hauling hazmat)',
];

test('category names match the 12 written names', () => {
  assert.deepEqual(CATEGORIES.map((c) => c.name), NAMES);
  assert.deepEqual(DOC_CATEGORY_NAMES, NAMES);
  assert.equal(categoryForDocType('w9'), 'Taxes & Fuel Tax');
  assert.equal(categoryForDocType('coi'), 'Insurance');
  assert.equal(categoryForDocType('noa'), 'Billing & Factoring');
  assert.equal(categoryForDocType('other:notes'), null);
});

test('ELD manual is recommended and unverified items are flagged', () => {
  assert.equal(itemByKey('eld_manual').level, 'recommended');
  assert.equal(itemByKey('spare_fuses').level, 'recommended');
  assert.equal(itemByKey('blank_logs').verified, true);
  assert.equal(UNVERIFIED_KEYS.length, 13);
  for (const key of UNVERIFIED_KEYS) assert.equal(itemByKey(key).verified, false);
});

test('migration allow-list matches equipment and binder keys', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261021120000_setup_checklist.sql', import.meta.url), 'utf8');
  for (const key of [...DRIVER_EQUIPMENT_KEYS, ...DRIVER_BINDER_KEYS]) assert.match(sql, new RegExp(`'${key}'`));
  assert.ok(DRIVER_EQUIPMENT_KEYS.includes('fire_extinguisher'));
  assert.ok(DRIVER_BINDER_KEYS.includes('eld_manual'));
  assert.ok(!DRIVER_BINDER_KEYS.includes('binder_medical'));
  assert.match(sql, /checked_by uuid not null default auth\.uid\(\)/);
  assert.match(sql, /checked_by = auth\.uid\(\)/);
  const reminders = readFileSync(new URL('../../supabase/migrations/20261021120100_compliance_reminders.sql', import.meta.url), 'utf8');
  assert.match(reminders, /acted_by uuid not null default auth\.uid\(\)/);
  assert.match(reminders, /acted_by = auth\.uid\(\)/);
  assert.doesNotMatch(reminders, /for all to authenticated/);
});

test('MCS-150 month and year come from the last two USDOT digits, with no weekend shift', () => {
  assert.deepEqual(mcs150Schedule('0000052'), { month: 2, oddYears: true });
  assert.equal(nextMcs150Due('0000052', '2026-10-21'), '2027-02-28');
  assert.equal(mcs150Schedule('0000010').month, 10);
  assert.equal(nextMcs150Due('0000020', '2026-10-21'), '2026-10-31');
  assert.equal(nextMcs150Due('0000010', '2026-10-21'), '2027-10-31');
  assert.equal(mcs150Schedule('5'), null);
  assert.equal(mcs150Schedule(''), null);
});

test('IFTA quarter dates shift off weekends and holidays', () => {
  assert.equal(iftaNominal(2026, 3), '2026-10-31');
  assert.equal(iftaDue(2026, 3), '2026-11-02');
  assert.equal(iftaDue(2026, 4), '2027-02-01');
  assert.equal(nextBusinessDay('2026-07-04'), '2026-07-06');
  assert.equal(nextBusinessDay('2026-04-30'), '2026-04-30');
});

test('Form 2290 is the last business day of the month after first use', () => {
  assert.equal(form2290DueForFirstUse('2026-07-01'), '2026-08-31');
  assert.equal(form2290DueForFirstUse('2025-07-15'), '2025-09-02');
  assert.equal(form2290DueForFirstUse('2026-10-04'), '2026-11-30');
});

test('UCR window opens October 1 and is due before January 1', () => {
  const ucr = ucrCycle('2026-10-21');
  assert.equal(ucr.opens, '2026-10-01');
  assert.equal(ucr.due, '2026-12-31');
  assert.equal(ucr.registrationYear, 2027);
  assert.equal(ucr.open, true);
  assert.equal(ucrCycle('2026-09-01').open, false);
});

test('a skipped required item stays missing and blocks nothing', () => {
  const ctx = base({
    statuses: [{ item_key: 'accident_register', status: 'skipped', checked_at: '2026-10-01' }],
  });
  const row = buildChecklist(ctx).find((r) => r.itemKey === 'accident_register');
  assert.equal(row.skipped, true);
  assert.equal(row.done, false);
  assert.equal(row.bucket, 'missing');
  assert.equal(matchesFilter(row, 'missing'), true);
  assert.equal(summarize(buildChecklist(ctx)).blocks, false);
});

test('equipment is due again a year after it was checked', () => {
  assert.equal(equipmentCurrent('2026-10-21', '2026-10-21'), true);
  assert.equal(equipmentCurrent('2025-10-20', '2026-10-21'), false);
  const fresh = buildChecklist(base({
    trucks: [truck],
    statuses: [{ item_key: 'fire_extinguisher', truck_id: 't1', status: 'done', checked_at: '2026-10-01' }],
  })).find((r) => r.itemKey === 'fire_extinguisher');
  assert.equal(fresh.done, true);
  const stale = buildChecklist(base({
    trucks: [truck],
    statuses: [{ item_key: 'fire_extinguisher', truck_id: 't1', status: 'done', checked_at: '2025-01-01' }],
  })).find((r) => r.itemKey === 'fire_extinguisher');
  assert.equal(stale.done, false);
  assert.match(stale.detail, /again/);
});

test('answering no hides conditional items, including hazmat', () => {
  assert.equal(answerApplies('hazmat', { hazmat: false }), false);
  assert.equal(answerApplies('hazmat', {}), true);
  const hidden = buildChecklist(base({ answers: { hazmat: false, flatbed: false, cdl_drivers: false } }));
  assert.equal(hidden.find((r) => r.itemKey === 'hazmat_papers').applicable, false);
  assert.equal(hidden.find((r) => r.itemKey === 'tarps').applicable, false);
  assert.equal(hidden.find((r) => r.itemKey === 'da_policy').applicable, false);
  const shown = buildChecklist(base({ answers: { hazmat: true }, trucks: [truck] })).find((r) => r.itemKey === 'hazmat_papers');
  assert.equal(shown.applicable, true);
});

test('binder echoes are not a second item to finish', () => {
  const rows = buildChecklist(base({ trucks: [truck], drivers: [driver] }));
  assert.equal(rows.filter((r) => r.itemKey === 'medical_card').length, 1);
  assert.equal(rows.some((r) => r.itemKey === 'binder_medical'), false);
  const progress = summarize(rows);
  const requiredKeys = rows.filter((r) => r.counts && r.level === 'required').map((r) => r.itemKey);
  assert.equal(requiredKeys.filter((k) => k === 'medical_card').length, 1);
  assert.equal(progress.blocks, false);
});

test('driver file counts exclude drug and alcohol records', () => {
  const rows = buildChecklist(base({ drivers: [driver], answers: { cdl_drivers: true } }));
  const file = driverFileRows('d1', rows);
  assert.ok(file.length > 0);
  assert.ok(file.every((r) => r.category === 'driver_files'));
  assert.ok(!file.some((r) => r.itemKey === 'preemployment_drug'));
  for (const type of DRIVER_FILE_DOC_TYPES) {
    assert.equal(CHECKLIST_ITEMS.find((i) => i.docType === type).category, 'driver_files');
  }
  assert.ok(CHECKLIST_ITEMS.filter((i) => i.category === 'drug_alcohol' && i.docType).every((i) => !DRIVER_FILE_DOC_TYPES.includes(i.docType)));
});

test('a current upload finishes the item and an expired one does not', () => {
  const done = buildChecklist(base({
    documents: [{ id: 'doc1', doc_type: 'w9', created_at: '2026-10-01', original_filename: 'w9.pdf' }],
  })).find((r) => r.itemKey === 'w9');
  assert.equal(done.done, true);
  const coi = buildChecklist(base({
    coiExpiry: '2026-11-04',
    documents: [{ id: 'doc2', doc_type: 'coi', created_at: '2026-01-01', original_filename: 'coi.pdf' }],
  })).find((r) => r.itemKey === 'coi');
  assert.equal(coi.bucket, 'expiring');
  assert.equal(coi.done, true);
  const expired = buildChecklist(base({
    coiExpiry: '2026-10-01',
    documents: [{ id: 'doc3', doc_type: 'coi', created_at: '2025-01-01' }],
  })).find((r) => r.itemKey === 'coi');
  assert.equal(expired.bucket, 'expired');
  assert.equal(expired.done, false);
});

test('roadside card is per truck and counts required cab papers once', () => {
  const ctx = base({
    trucks: [truck],
    documents: [{ id: 'c', doc_type: 'coi', created_at: '2026-01-01' }],
  });
  const rows = buildChecklist(ctx);
  const card = roadsideForTruck(truck, ctx, rows);
  assert.equal(card.total > 0, true);
  assert.equal(card.items.filter((r) => r.itemKey === 'coi').length, 1);
});

test('cycle coverage and the new-company guide window', () => {
  const covered = cycleState({ today: '2026-10-21', due: '2027-02-28', cycleMonths: 24, docs: [{ created_at: '2025-03-01' }], warningDays: 30 });
  assert.equal(covered.done, true);
  assert.equal(covered.bucket, 'done');
  const expired = cycleState({ today: '2027-03-01', due: '2027-02-28', cycleMonths: 24, docs: [{ created_at: '2025-03-01' }], warningDays: 30 });
  assert.equal(expired.bucket, 'expired');
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(setupEntry({ created_at: '2026-10-21T08:00:00Z', owner_id: 'u' }, 'owner', now), 'guide');
  assert.equal(setupEntry({ created_at: '2026-10-20T00:00:00Z', owner_id: 'u' }, 'owner', now), 'prompt');
  assert.equal(setupEntry({}, 'owner', now), 'prompt');
  assert.equal(setupEntry({ created_at: '2026-10-21T08:00:00Z' }, 'owner', now, { trucks: 1 }), 'prompt');
  assert.equal(setupEntry({ created_at: '2020-01-01T00:00:00Z' }, 'owner', now), 'prompt');
  assert.equal(setupEntry({ created_at: '2026-10-21T08:00:00Z', setup_started_at: '2026-10-21' }, 'owner', now), null);
  assert.equal(setupEntry({ created_at: '2020-01-01T00:00:00Z' }, 'driver', now), null);
  assert.equal(NEW_COMPANY_MS, 86400000);
});

test('a done tick shows who marked it', () => {
  const row = buildChecklist(base({
    trucks: [truck],
    people: { u1: { name: 'Taylor', email: 'taylor@example.com' } },
    statuses: [{ item_key: 'fire_extinguisher', truck_id: 't1', status: 'done', checked_by: 'u1', checked_at: '2026-10-21T15:00:00Z' }],
  })).find((r) => r.itemKey === 'fire_extinguisher');
  assert.equal(row.done, true);
  assert.equal(row.ticked, true);
  assert.equal(row.markedBy, 'Marked done by Taylor on 2026-10-21.');
  const byEmail = buildChecklist(base({
    trucks: [truck],
    people: { u1: { email: 'taylor@example.com' } },
    statuses: [{ item_key: 'fire_extinguisher', truck_id: 't1', status: 'done', checked_by: 'u1', checked_at: '2026-10-21T15:00:00Z' }],
  })).find((r) => r.itemKey === 'fire_extinguisher');
  assert.equal(byEmail.markedBy, 'Marked done by taylor@example.com on 2026-10-21.');
});

test('calendar lists the verified rules and not a guessed factoring card', () => {
  const entries = complianceEntries({ today: '2026-10-21', dot: '0000052', answers: { interstate: true, ifta_irp: true, hvut: true }, hvutFirstUseOn: '2026-07-01' });
  assert.ok(entries.some((e) => e.ruleKey === 'mcs150' && e.due === '2027-02-28'));
  assert.ok(entries.some((e) => e.ruleKey === 'ifta_quarter' && e.due === '2026-11-02'));
  assert.ok(entries.some((e) => e.ruleKey === 'ucr' && e.due === '2026-12-31'));
  assert.ok(entries.some((e) => e.ruleKey === 'form_2290' && e.due === '2026-08-31'));
  const up = comingUp(entries, '2026-10-21');
  assert.equal(up.some((e) => e.dismissed), false);
  const model = modelFromPayload({ profile: { dot_number: '0000052', operation_answers: {} } }, '2026-10-21');
  assert.equal(model.dot, '0000052');
  const card = buildChecklist(base({ trucks: [truck] })).find((r) => r.itemKey === 'cab_card');
  assert.equal(card.expiry, 'yearly');
});

test('driver file pdf is one file and skips a drug record', async () => {
  const pdf = await buildDriverFilePdf({
    companyName: 'Test Hauling', usdot: '0000000', driverName: 'J. Test', date: '2026-10-21',
    rows: [{ title: 'Copy of CDL', category: 'driver_files', done: false, bucket: 'missing' }],
    files: [{ name: 'drug.pdf', docType: 'da_consortium', contentType: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) }],
  });
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
});

test('home coming up keeps a document expiry due within 30 days', () => {
  const today = '2026-10-21';
  const calendar = [1, 2, 3, 4, 5].map((n) => ({
    ruleKey: `rule_${n}`, period: `q${n}`, due: `2026-10-2${n}`, title: `Quarter ${n}`,
    completed: false, dismissed: false,
  }));
  const medical = { ruleKey: 'expiry:medical_card', period: 'medical', due: '2026-11-20', title: 'Medical card', itemKey: 'medical_card', completed: false, dismissed: false };
  const up = homeComingUp([...calendar, medical], today, 5);
  assert.ok(up.some((e) => e.itemKey === 'medical_card' && e.due === '2026-11-20'));
  const later = { ...medical, ruleKey: 'expiry:cab_card', due: '2026-11-21', period: 'later', itemKey: 'cab_card' };
  assert.equal(homeComingUp([...calendar, later], today, 5).some((e) => e.due === '2026-11-21'), false);
  const rows = buildChecklist(base({
    trucks: [truck],
    drivers: [{ id: 'd1', name: 'Sam', truck_id: 't1', med_card_expiry: '2026-11-20' }],
  }));
  const card = rows.find((r) => r.itemKey === 'medical_card');
  assert.equal(card.expiryOn, '2026-11-20');
  assert.ok(expiryEntries(rows, today).some((e) => e.itemKey === 'medical_card' && e.due === '2026-11-20'));
});

test('home coming up keeps IFTA when prompts and a medical expiry are also due', () => {
  const today = '2026-10-21';
  const calendar = complianceEntries({
    today, dot: '0000000', answers: { interstate: true, ifta_irp: true, hvut: true },
  });
  const medical = {
    ruleKey: 'expiry:medical_card', period: 'med', due: '2026-11-05', title: 'Medical examiner’s certificate (Sam)',
    itemKey: 'medical_card', needs: 'upload', completed: false, dismissed: false,
  };
  const up = homeComingUp([...calendar, medical], today);
  assert.ok(up.some((e) => e.title === 'IFTA Q3 2026 return' && e.due === '2026-11-02'));
  assert.ok(up.some((e) => e.ruleKey === 'mcs150' && e.due === '2026-10-31'));
  assert.ok(up.some((e) => e.itemKey === 'medical_card' && e.due === '2026-11-05'));
  assert.equal(up.some((e) => e.ruleKey === 'ucr'), false);
  const dated = up.filter((e) => e.needs !== 'date');
  assert.deepEqual(dated.map((e) => e.due), ['2026-10-31', '2026-11-02', '2026-11-05']);
  for (const e of dated) {
    const days = daysBetween(today, e.due);
    assert.ok(days >= 0 && days <= 30, `${e.title} ${e.due}`);
  }
  assert.ok(up.filter((e) => e.needs === 'date').length >= 3);
  const dates = up.map((e) => e.due);
  assert.deepEqual(dates, [...dates].sort());
});

test('a driver tick uses the driver name before the email', () => {
  const linked = buildChecklist(base({
    role: 'driver', userId: 'u1', trucks: [truck],
    drivers: [{ id: 'd1', name: 'Sam Driver', truck_id: 't1', auth_user_id: 'u1' }],
    people: { u1: { email: 'sam@example.com' } },
    statuses: [{ item_key: 'fire_extinguisher', truck_id: 't1', status: 'done', checked_by: 'u1', checked_at: '2026-10-21T15:00:00Z' }],
  })).find((r) => r.itemKey === 'fire_extinguisher');
  assert.equal(linked.markedBy, 'Marked done by Sam Driver on 2026-10-21.');
  const named = applyDriverNames(
    { u1: { name: 'sam@example.com', email: 'sam@example.com' } },
    ['u1'],
    { drivers: [{ id: 'd1', name: 'Sam Driver', truck_id: 't1' }], members: [{ user_id: 'u1', role: 'driver' }], statuses: [{ checked_by: 'u1', truck_id: 't1' }] },
  );
  assert.equal(named.u1.name, 'Sam Driver');
  const owner = applyDriverNames(
    { o1: { email: 'office@example.com' } },
    ['o1'],
    { drivers: [{ id: 'd1', name: 'Sam Driver', truck_id: 't1' }], members: [{ user_id: 'o1', role: 'owner' }], statuses: [{ checked_by: 'o1', truck_id: 't1' }] },
  );
  assert.equal(owner.o1.name, null);
});

test('a skipped item can be undone back to not done', () => {
  const row = buildChecklist(base({
    trucks: [truck],
    statuses: [{ item_key: 'fire_extinguisher', truck_id: 't1', status: 'skipped' }],
  })).find((r) => r.itemKey === 'fire_extinguisher');
  assert.equal(row.skipped, true);
  assert.equal(row.done, false);
  assert.equal(showUndo(row, true), true);
  assert.equal(showUndo(row, false), true);
  const officeOnly = { applicable: true, skipped: true, done: false, driverAccess: 'office', kinds: ['upload', 'audit'] };
  assert.equal(showUndo(officeOnly, true), true);
  assert.equal(showUndo(officeOnly, false), false);
});

const truck = { id: 't1', unit_number: '101' };
const driver = { id: 'd1', name: 'J. Test', truck_id: 't1' };
function base(extra = {}) {
  return {
    today: '2026-10-21', dot: '0000052', answers: {}, trucks: [], trailers: [], drivers: [],
    documents: [], statuses: [], reminders: [], ...extra,
  };
}
