// Dispatcher / management load creation (migration 20261019000100, public.dispatch_create_load). Fake data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formToNewLoad, createLoad, errorText, loadToForm, CREATE_SETUP_MSG, NEW_LOAD_KEYS } from '../../app/lib/dispatch.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const D = '00000000-0000-0000-0000-00000000000d', O = '00000000-0000-0000-0000-00000000000a';
const stub = (result) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); return result; } }; };

test('formToNewLoad: rate required, numbers checked, empty fields left out, booked by default', () => {
  assert.equal(formToNewLoad(loadToForm({})).load, null);
  assert.ok(formToNewLoad(loadToForm({})).errors.rate);
  assert.ok(formToNewLoad({ ...loadToForm({}), rate: '1,280', total_miles: 'abc' }).errors.total_miles);
  const { load } = formToNewLoad({ ...loadToForm({}), rate: '$1,280', total_miles: '512', weight: '38500.6', broker_name: '  Demo Broker (FAKE) ', notes: '' });
  assert.deepEqual(load, { status: 'booked', broker_name: 'Demo Broker (FAKE)', rate: 1280, total_miles: 512, weight: 38501, show_rate_to_driver: false });
});

test('formToNewLoad: driver + show rate kept together; show rate dropped without a driver', () => {
  assert.equal(formToNewLoad({ ...loadToForm({}), rate: '1', broker_name: 'Demo (FAKE)', show_rate_to_driver: true }).load.show_rate_to_driver, false);
  const l = formToNewLoad({ ...loadToForm({}), rate: '1', broker_name: 'Demo (FAKE)', status: 'dispatched', assigned_driver_user_id: D, show_rate_to_driver: true }).load;
  assert.equal(l.assigned_driver_user_id, D); assert.equal(l.show_rate_to_driver, true); assert.equal(l.status, 'dispatched');
});

test('createLoad: one RPC with owner id, allow-listed load keys and the stops; returns the id', async () => {
  const sb = stub({ data: 'aaaaaaaa-0000-0000-0000-000000000001', error: null });
  const stops = [{ stop_type: 'pickup', city: 'Ontario', pickup_number: 'PU-1' }, { stop_type: 'delivery', city: 'Phoenix' }];
  const r = await createLoad(sb, O, { user_id: 'someone-else', miles_source: 'typed', rate: 10, notes: 'Load board: DAT' }, stops);
  assert.deepEqual(r, { ok: true, id: 'aaaaaaaa-0000-0000-0000-000000000001' });
  assert.equal(sb.calls.length, 1);
  assert.equal(sb.calls[0].fn, 'dispatch_create_load');
  assert.deepEqual(sb.calls[0].args, { p_owner: O, p_load: { rate: 10, notes: 'Load board: DAT' }, p_stops: stops });
  assert.ok(!NEW_LOAD_KEYS.includes('user_id'));
});

test('createLoad: database error codes become plain text; missing function → setup message', async () => {
  let r = await createLoad(stub({ data: null, error: { message: 'not_allowed' } }), O, { rate: 1 }, []);
  assert.equal(r.ok, false); assert.match(r.error, /Only management and dispatchers/);
  r = await createLoad(stub({ data: null, error: { message: 'assigned_driver_not_driver' } }), O, { rate: 1 }, []);
  assert.match(r.error, /not a driver/);
  r = await createLoad(stub({ data: null, error: { message: 'missing_delivery' } }), O, { rate: 1 }, []);
  assert.match(r.error, /at least one delivery/);
  r = await createLoad(stub({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.dispatch_create_load' } }), O, { rate: 1 }, []);
  assert.equal(r.setup, true); assert.equal(r.error, CREATE_SETUP_MSG);
  assert.match(errorText({ message: 'not_signed_in' }), /sign in again/);
});

test('/dispatch/new page: shared StopsEditor, driver picker, calls createLoad with the company owner, neutral pay warning', () => {
  const page = read('app/dispatch/new/page.js');
  assert.match(page, /import StopsEditor, \{ Field, STOP_STYLES \} from '\.\.\/\.\.\/components\/StopsEditor'/);
  assert.match(page, /<StopsEditor stops=\{stops\} setStops=\{setStops\}/);
  assert.match(page, /blankStop\('pickup', browserTz\), blankStop\('delivery', browserTz\)/);
  assert.match(page, /createLoad\(supabase, state\.company\.owner_id, l\.load, st\.payload\)/);
  assert.match(page, /router\.push\(`\/dispatch\/\$\{r\.id\}`\)/);
  assert.match(page, /fetchDriverChoices\(supabase, company\.owner_id\)/);
  assert.match(page, /don’t want them to see/);
  assert.doesNotMatch(page, /#[0-9a-fA-F]{3,6}\b/, 'no hex colours (dark-mode tokens only)');
  assert.match(read('app/dispatch/page.js'), /href="\/dispatch\/new" data-testid="dispatch-new-load"/);
});

test('migration: SECURITY DEFINER, search_path, owner user_id, authenticated-only grant, reuses dispatch_save_stops', () => {
  const sql = read('supabase/migrations/20261019000100_dispatch_create_load.sql');
  assert.match(sql, /create or replace function public\.dispatch_create_load\(p_owner uuid, p_load jsonb, p_stops jsonb\)\nreturns uuid\nlanguage plpgsql security definer set search_path = public/);
  assert.match(sql, /values \(v_profile\.owner_id,/);
  assert.match(sql, /m\.role in \('management', 'dispatcher'\)/);
  assert.match(sql, /m\.role = 'driver'/);
  assert.match(sql, /perform public\.dispatch_save_stops\(v_id, p_stops\)/);
  assert.match(sql, /revoke all on function public\.dispatch_create_load\(uuid, jsonb, jsonb\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.dispatch_create_load\(uuid, jsonb, jsonb\) to authenticated;/);
});
