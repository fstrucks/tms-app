// PR A: rate con miles → loads.total_miles; typed wins; source note; logged miles = "actual" (migration 0300, not applied).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { parseTripMiles, extractedMiles, writeLoadMiles, fillLinkedLoadMiles, milesSourceNote, isMissingMilesSource, hasMilesSourceColumn } from '../../app/lib/loadMiles.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa', OTHER = '00000000-0000-4000-8000-00000000cccc';
const L1 = '00000000-0000-4000-8000-0000000000d1', L2 = '00000000-0000-4000-8000-0000000000d2', LX = '00000000-0000-4000-8000-0000000009d1';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Before the migration PostgREST rejects the unknown column, like prod today.
function preMigration(db) {
  const from = db.from;
  db.from = (t) => {
    const api = from(t);
    const update = api.update;
    api.update = (p) => (t === 'loads' && 'miles_source' in p
      ? { eq() { return this; }, is() { return this; }, select: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'miles_source' column of 'loads' in the schema cache" } }) }
      : update(p));
    return api;
  };
  return db;
}

test('parseTripMiles: printed miles → whole number; junk/implausible → null', () => {
  assert.equal(parseTripMiles(626), 626);
  assert.equal(parseTripMiles('1,270 mi'), 1270);
  assert.equal(parseTripMiles('314mi'), 314);
  assert.equal(parseTripMiles(314.6), 315);
  for (const v of [null, undefined, '', 'n/a', 0, -5, 0.2, 99999, NaN]) assert.equal(parseTripMiles(v), null, String(v));
  assert.equal(extractedMiles({ total_miles: 626 }), 626);
  assert.equal(extractedMiles({ weight: '38,500 lbs' }), null); // reads from before PR A
  assert.equal(extractedMiles(null), null);
});

test('extract route: schema asks for total_miles, prompt ignores driving directions, value is parsed and saved', () => {
  const src = read('../../app/api/extract/route.js');
  assert.match(src, /total_miles: \{ type: \['number', 'null'\]/);
  assert.match(src, /'weight', 'total_miles', 'notes'\]/);
  assert.match(src, /IGNORE any miles that appear only inside driving directions/);
  assert.match(src, /Do not add segments up, do not estimate from addresses/);
  assert.match(src, /total_miles: parseTripMiles\(loadData\.total_miles\)/);
  assert.ok(src.indexOf('fillLinkedLoadMiles(userDb') > src.indexOf("update({ ai_extracted_data: extracted })"), 'fills after the read is saved');
  assert.match(src, /fillLinkedLoadMiles\(userDb, \{ loadId: doc\.load_id, userId: user\.id, miles: extracted\.total_miles \}\)/);
});

test('re-run: fills an EMPTY total_miles with source rate_con; a typed/earlier value is kept', async () => {
  const db = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, total_miles: null }, { id: L2, user_id: OWNER, total_miles: 700, miles_source: 'typed' }, { id: LX, user_id: OTHER, total_miles: null }] } });
  assert.deepEqual(await fillLinkedLoadMiles(db, { loadId: L1, userId: OWNER, miles: 626 }), { filled: true, miles: 626 });
  assert.deepEqual([db.db.loads[0].total_miles, db.db.loads[0].miles_source], [626, 'rate_con']);
  const kept = await fillLinkedLoadMiles(db, { loadId: L2, userId: OWNER, miles: 626 });
  assert.equal(kept.skipped, 'kept_existing');
  assert.deepEqual([db.db.loads[1].total_miles, db.db.loads[1].miles_source], [700, 'typed']);
  assert.equal((await fillLinkedLoadMiles(db, { loadId: LX, userId: OWNER, miles: 626 })).filled, false); // another owner's load
  assert.equal(db.db.loads[2].total_miles, null);
  assert.equal((await fillLinkedLoadMiles(db, { loadId: null, userId: OWNER, miles: 626 })).skipped, 'no_linked_load');
  assert.equal((await fillLinkedLoadMiles(db, { loadId: L1, userId: OWNER, miles: null })).skipped, 'no_miles');
  const q = db.calls.find((c) => c.op === 'update');
  assert.deepEqual(q.eqs, [['id', L1], ['user_id', OWNER], ['is:total_miles', null]]);
});

test('before the migration: writes retry without miles_source and still save the miles', async () => {
  const db = preMigration(fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, total_miles: null }] } }));
  assert.deepEqual(await fillLinkedLoadMiles(db, { loadId: L1, userId: OWNER, miles: 1270 }), { filled: true, miles: 1270 });
  assert.equal(db.db.loads[0].total_miles, 1270);
  assert.equal('miles_source' in db.db.loads[0], false);
  const typed = await writeLoadMiles(db, { loadId: L1, miles: 1300, source: 'typed' });
  assert.equal(typed.error, null); assert.equal(typed.migrated, false);
  assert.equal(db.db.loads[0].total_miles, 1300);
  assert.equal(isMissingMilesSource({ code: '42703', message: 'column "miles_source" of relation "loads" does not exist' }), true);
  assert.equal(isMissingMilesSource({ code: '42501', message: 'permission denied' }), false);
});

test('after the migration: a typed save sets miles_source=typed; clearing clears the source', async () => {
  const db = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, total_miles: 626, miles_source: 'rate_con' }] } });
  const r = await writeLoadMiles(db, { loadId: L1, miles: 640, source: 'typed' });
  assert.equal(r.migrated, true);
  assert.deepEqual([db.db.loads[0].total_miles, db.db.loads[0].miles_source], [640, 'typed']);
  await writeLoadMiles(db, { loadId: L1, miles: null, source: 'typed' });
  assert.deepEqual([db.db.loads[0].total_miles, db.db.loads[0].miles_source], [null, null]);
});

test('source note: stored source wins; otherwise inferred (rate con / mileage log / typed)', () => {
  assert.equal(milesSourceNote({ load: { total_miles: 626, miles_source: 'rate_con' } }), 'from rate con');
  assert.equal(milesSourceNote({ load: { total_miles: 640, miles_source: 'typed' }, rateConMiles: 640 }), 'typed');
  assert.equal(milesSourceNote({ load: { total_miles: 626 }, rateConMiles: 626 }), 'from rate con'); // pre-migration
  assert.equal(milesSourceNote({ load: { total_miles: 650 }, rateConMiles: 626 }), 'typed');
  assert.equal(milesSourceNote({ load: { total_miles: 600 }, rateConMiles: 626, loggedTotal: 600 }), 'from mileage log');
  assert.equal(milesSourceNote({ load: { total_miles: null, miles_source: null } }), null);
  assert.equal(milesSourceNote({ load: { total_miles: 610, miles_source: 'calculated' } }), 'calculated route miles');
  assert.equal(hasMilesSourceColumn({ miles_source: null }), true);
  assert.equal(hasMilesSourceColumn({ total_miles: 1 }), false);
});

test('create from document copies rate con miles into an empty total_miles (same pattern as weight/equipment)', () => {
  const src = read('../../app/documents/page.js');
  const create = src.slice(src.indexOf('async function createLoad'), src.indexOf('const [status, setStatus]'));
  assert.match(create, /extractedMiles\(doc\.ai_extracted_data\)/);
  assert.match(create, /fillLinkedLoadMiles\(supabase, \{ loadId, userId: null, miles: mi \}\)/);
  assert.ok(create.indexOf('fillLinkedLoadMiles') < create.indexOf('router.push'), 'before opening the load');
  assert.match(src, /\['Miles', extractedMiles\(x\) \?/);
});

test('load page Miles card: planned input always shown + grey source note; log shown separately as actual', () => {
  const src = read('../../app/components/LoadMileage.js');
  assert.match(src, /Planned miles/);
  assert.match(src, /data-testid="miles-source" style=\{\{ \.\.\.muted/);
  assert.match(src, /data-testid="miles-both"/); // Marc: "I like seeing both"
  assert.ok(src.indexOf('data-testid="planned-miles"') < src.indexOf('data-testid="actual-total"'), 'Planned left, Actual right');
  assert.match(src, /Actual \(mileage log\)/);
  assert.match(src, /writeLoadMiles\(supabase, \{ loadId: load\.id, miles: v, source: 'typed'/);
  assert.match(src, /select\('\*'\)\.eq\('id', load\.id\)/); // works with and without miles_source
  assert.doesNotMatch(src, /select\('total_miles, rate_per_mile, miles_source'\)/);
  // The planned form is no longer hidden when the load has log entries.
  assert.ok(src.indexOf('planned-miles-form') < src.indexOf('list.length > 0 ?'));
});

test('migration 0300: adds miles_source, stops log totals overwriting total_miles, keeps rate_per_mile, no data changes', () => {
  const sql = read('../../supabase/migrations/20261018000300_load_miles_source.sql');
  assert.match(sql, /add column if not exists miles_source text;/);
  assert.match(sql, /check \(miles_source is null or miles_source in \('typed', 'rate_con', 'calculated'\)\)/);
  assert.match(sql, /grant update \(miles_source\) on public\.loads to authenticated;/);
  const fn = sql.slice(sql.indexOf('create or replace function public.loads_compute_rate_per_mile'), sql.indexOf('drop trigger if exists loads_compute_rate_per_mile'));
  assert.doesNotMatch(fn, /mileage_entries|total_miles :=/);
  assert.match(fn, /new\.rate_per_mile := round/);
  assert.match(sql, /drop trigger if exists mileage_entries_recalc_load on public\.mileage_entries;/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bupdate public\.|\bdelete from\b|\bdrop table\b|\bdrop column\b/i);
});

test('precedence typed > rate con > calculated: rate con replaces calculated miles, never typed', async () => {
  const db = fakeSupabase({ tables: { loads: [{ id: L1, user_id: OWNER, total_miles: 610, miles_source: 'calculated' }, { id: L2, user_id: OWNER, total_miles: 700, miles_source: 'typed' }] } });
  assert.deepEqual(await fillLinkedLoadMiles(db, { loadId: L1, userId: OWNER, miles: 626 }), { filled: true, miles: 626, replaced: 'calculated' });
  assert.deepEqual([db.db.loads[0].total_miles, db.db.loads[0].miles_source], [626, 'rate_con']);
  assert.equal((await fillLinkedLoadMiles(db, { loadId: L2, userId: OWNER, miles: 626 })).skipped, 'kept_existing');
  assert.deepEqual([db.db.loads[1].total_miles, db.db.loads[1].miles_source], [700, 'typed']);
  assert.equal((await fillLinkedLoadMiles(db, { loadId: L1, userId: OWNER, miles: 999 })).skipped, 'kept_existing'); // earlier rate con kept
});
