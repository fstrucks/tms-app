// Owner-operator can assign himself as a load's driver (Marc, Oct 20 2026). No SQL: the DB trigger already allows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchDriverChoices, withSelfDriver, withOwnerDriver, OWNER_DRIVER_LABEL, driverOptions, FORMER_DRIVER_LABEL } from '../../app/lib/loadDriver.js';
import { driverMap } from '../../app/lib/dispatch.js';

const src = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const sb = (rows, user = { id: 'owner-1', email: 'owner@test.invalid' }, err = null) => ({
  calls: [], rpc(name, args) { this.calls.push([name, args]); return Promise.resolve({ data: err ? null : rows, error: err }); },
  auth: { getSession: () => Promise.resolve({ data: { session: user ? { user } : null } }) },
});
const drv = [{ user_id: 'd1', email: 'driver1@test.invalid' }];

test('owner pages: "Me (email)" comes first, then Driver members', async () => {
  const r = await fetchDriverChoices(sb(drv));
  assert.equal(r.available, true);
  assert.deepEqual(r.choices.map((c) => c.user_id), ['owner-1', 'd1']);
  assert.equal(r.choices[0].email, 'Me (owner@test.invalid)'); assert.equal(r.choices[0].self, true);
});

test('solo owner with no drivers still gets Me; no duplicate if listed; signed out → just the list', async () => {
  assert.deepEqual((await fetchDriverChoices(sb([]))).choices.map((c) => c.user_id), ['owner-1']);
  assert.deepEqual(withSelfDriver([{ user_id: 'owner-1', email: 'x' }, ...drv], { id: 'owner-1', email: 'o@t' }).map((c) => c.user_id), ['owner-1', 'd1']);
  assert.deepEqual((await fetchDriverChoices(sb(drv, null))).choices.map((c) => c.user_id), ['d1']);
});

test('before migration 0600 the picker stays hidden (no Me option either)', async () => {
  const r = await fetchDriverChoices(sb(null, undefined, { code: 'PGRST202', message: 'Could not find the function' }));
  assert.equal(r.available, false); assert.deepEqual(r.choices, []);
});

test('dispatch pages (ownerId given): no self option; the owner is labeled, not "no longer on the company"', async () => {
  const r = await fetchDriverChoices(sb(drv, { id: 'mgr-1', email: 'm@t' }), 'owner-1');
  assert.deepEqual(r.choices.map((c) => c.user_id), ['d1']);
  const withOwner = withOwnerDriver(r.choices, 'owner-1');
  assert.deepEqual(withOwner.map((c) => c.user_id), ['d1', 'owner-1']);
  assert.equal(driverMap(withOwner)['owner-1'], OWNER_DRIVER_LABEL);
  const opts = driverOptions(withOwner, 'owner-1', true).options;
  assert.ok(!opts.some((o) => o.email === FORMER_DRIVER_LABEL));
});

test('wiring: load page + /loads/new use the owner list; dispatch edit + board add the owner; /dispatch/new too (20261020000100)', () => {
  assert.match(src('app/components/LoadDriverSettings.js'), /fetchDriverChoices\(supabase\)/);
  assert.match(src('app/loads/new/page.js'), /fetchDriverChoices\(supabase\)/);
  assert.match(src('app/dispatch/[id]/page.js'), /withOwnerDriver\(drv\.choices, load\.owner_id\)/);
  assert.match(src('app/dispatch/page.js'), /withOwnerDriver\(drv\.choices, company\.owner_id\)/);
  assert.match(src('app/dispatch/new/page.js'), /withOwnerDriver\(drv\.choices, company\.owner_id\)/); // allowed since 20261020000100
});

test('database already allows the owner as driver (trigger exempts assigned = loads.user_id)', () => {
  const m = src('supabase/migrations/20261018000700_dispatch_center.sql');
  assert.match(m, /new\.assigned_driver_user_id <> new\.user_id and not exists/);
});
