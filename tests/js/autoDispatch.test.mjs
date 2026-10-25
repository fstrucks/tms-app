// Assigning a driver dispatches the load. Fake data only. The database role checks stay in the existing RPCs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DISPATCH_STATUS, PRE_DISPATCH_STATUS, TERMINAL_STATUSES,
  statusAfterDriverChange, statusAfterDispatch, statusForNewAssignedLoad, showDispatchButton,
  formStatusOnDriverPick, formStatusOnStatusPick,
  dispatchLoad, writeOwnerLoadStatus,
} from '../../app/lib/autoDispatch.js';
import { formToPatch, formToNewLoad, loadToForm, createLoad } from '../../app/lib/dispatch.js';
import { buildNewLoad, createManualLoad, EMPTY_NEW_LOAD } from '../../app/lib/loadNew.js';
import { saveDriverSettings } from '../../app/lib/loadDriver.js';
import { buildBoardLoad, EMPTY_BOARD_FORM } from '../../app/lib/loadBoards.js';
import { pickCurrentLoad } from '../../app/lib/homeCurrentLoad.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const base = { rate: 100, broker_name: 'Demo Broker (FAKE)', broker_load_number: 'FAKE-1', total_miles: 10, weight: 1000,
  commodity: null, equipment_type: null, special_instructions: null, notes: '', show_rate_to_driver: false };

test('dispatch is a booked → dispatched status write, and it does not touch a later or terminal status', () => {
  assert.equal(PRE_DISPATCH_STATUS, 'booked');
  assert.equal(DISPATCH_STATUS, 'dispatched');
  assert.deepEqual(TERMINAL_STATUSES, ['delivered', 'invoiced', 'paid', 'cancelled']);
  assert.equal(statusAfterDispatch('booked'), 'dispatched');
  for (const st of ['dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled', 'completed', null]) {
    assert.equal(statusAfterDispatch(st), st);
  }
  assert.equal(showDispatchButton({ status: 'booked', driverId: D1 }), true);
  assert.equal(showDispatchButton({ status: 'booked', driverId: '' }), false);
  assert.equal(showDispatchButton({ status: 'dispatched', driverId: D1 }), false);
  assert.equal(showDispatchButton({ status: 'in_transit', driverId: D1 }), false);
  assert.equal(showDispatchButton({ status: 'cancelled', driverId: D1 }), false);
});

test('assigning a driver dispatches only a booked load; reassign, unassign, and later statuses stay put', () => {
  assert.equal(statusAfterDriverChange({ status: 'booked', previousDriver: null, nextDriver: D1 }), 'dispatched');
  assert.equal(statusAfterDriverChange({ status: 'booked', previousDriver: D1, nextDriver: D2 }), 'dispatched');
  assert.equal(statusAfterDriverChange({ status: 'booked', previousDriver: D1, nextDriver: D1 }), 'booked');
  assert.equal(statusAfterDriverChange({ status: 'dispatched', previousDriver: D1, nextDriver: D2 }), 'dispatched');
  assert.equal(statusAfterDriverChange({ status: 'in_transit', previousDriver: null, nextDriver: D1 }), 'in_transit');
  for (const st of TERMINAL_STATUSES) {
    assert.equal(statusAfterDriverChange({ status: st, previousDriver: null, nextDriver: D1 }), st);
  }
  assert.equal(statusAfterDriverChange({ status: 'dispatched', previousDriver: D1, nextDriver: null }), 'dispatched');
  assert.equal(statusAfterDriverChange({ status: 'in_transit', previousDriver: D1, nextDriver: '' }), 'in_transit');
  assert.equal(statusAfterDriverChange({ status: 'cancelled', previousDriver: D1, nextDriver: null }), 'cancelled');
  // An explicit status other than booked wins, including leaving a driver on a booked load the user moved on purpose.
  assert.equal(statusAfterDriverChange({ status: 'booked', previousDriver: null, nextDriver: D1, explicitStatus: 'in_transit' }), 'in_transit');
  assert.equal(statusAfterDriverChange({ status: 'booked', previousDriver: null, nextDriver: D1, explicitStatus: 'cancelled' }), 'cancelled');
  assert.equal(statusAfterDriverChange({ status: 'dispatched', previousDriver: D1, nextDriver: D1, explicitStatus: 'booked' }), 'booked');
  assert.equal(statusAfterDriverChange({ status: 'booked', previousDriver: null, nextDriver: null }), 'booked');
  assert.equal(statusAfterDriverChange({ status: null, previousDriver: null, nextDriver: D1 }), null);
});

test('the dispatch status menu shows Dispatched when a driver is chosen, and snaps Booked back', () => {
  assert.equal(formStatusOnDriverPick({ savedStatus: 'booked', savedDriver: null, nextDriver: D1, formStatus: 'booked' }), 'dispatched');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'booked', savedDriver: D1, nextDriver: D2, formStatus: 'booked' }), 'dispatched');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'dispatched', savedDriver: D1, nextDriver: D2, formStatus: 'dispatched' }), 'dispatched');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'dispatched', savedDriver: D1, nextDriver: '', formStatus: 'dispatched' }), 'dispatched');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'booked', savedDriver: null, nextDriver: '', formStatus: 'dispatched' }), 'booked');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'booked', savedDriver: null, nextDriver: D1, formStatus: 'in_transit' }), 'in_transit');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'booked', savedDriver: null, nextDriver: D1, formStatus: 'cancelled' }), 'cancelled');
  assert.equal(formStatusOnDriverPick({ savedStatus: 'in_transit', savedDriver: null, nextDriver: D1, formStatus: 'in_transit' }), 'in_transit');
  assert.equal(formStatusOnStatusPick({ savedStatus: 'booked', savedDriver: null, formDriver: D1, pickedStatus: 'booked' }), 'dispatched');
  assert.equal(formStatusOnStatusPick({ savedStatus: 'booked', savedDriver: null, formDriver: '', pickedStatus: 'dispatched' }), 'dispatched');
  assert.equal(formStatusOnStatusPick({ savedStatus: 'booked', savedDriver: null, formDriver: D1, pickedStatus: 'cancelled' }), 'cancelled');
  assert.equal(formStatusOnStatusPick({ savedStatus: 'dispatched', savedDriver: D1, formDriver: D1, pickedStatus: 'booked' }), 'booked');
  assert.equal(formStatusOnStatusPick({ savedStatus: 'in_transit', savedDriver: D1, formDriver: D2, pickedStatus: 'delivered' }), 'delivered');
});

test('a new load with a driver is dispatched; without one it stays booked; a chosen later status sticks', () => {
  assert.equal(statusForNewAssignedLoad({ status: 'booked' }), 'booked');
  assert.equal(statusForNewAssignedLoad({}), null);
  assert.equal(statusForNewAssignedLoad({ status: 'booked', assigned_driver_user_id: D1 }), 'dispatched');
  assert.equal(statusForNewAssignedLoad({ assigned_driver_user_id: D1 }), 'dispatched');
  assert.equal(statusForNewAssignedLoad({ status: 'dispatched', assigned_driver_user_id: D1 }), 'dispatched');
  assert.equal(statusForNewAssignedLoad({ status: 'in_transit', assigned_driver_user_id: D1 }), 'in_transit');
  assert.equal(statusForNewAssignedLoad({ status: 'cancelled', assigned_driver_user_id: D1 }), 'cancelled');
  assert.equal(statusForNewAssignedLoad({ status: 'dispatched', assigned_driver_user_id: D1 }), statusForNewAssignedLoad({ status: 'dispatched', assigned_driver_user_id: D1 }));
});

function ownerSb(result) {
  const calls = [];
  const sb = {
    from: (table) => ({
      update: (row) => {
        const eqs = [];
        const q = {
          eq: (k, v) => { eqs.push([k, v]); return q; },
          select: () => ({ maybeSingle: async () => { calls.push({ table, row, eqs }); return result; } }),
        };
        return q;
      },
    }),
    rpc: async () => { throw new Error('owner dispatch must not call an RPC'); },
  };
  return { sb, calls };
}

test('owner Dispatch writes status dispatched only from booked, same update as the load page', async () => {
  const ok = ownerSb({ data: { status: 'dispatched' }, error: null });
  const r = await dispatchLoad(ok.sb, { id: 'L1', status: 'booked', channel: 'owner' });
  assert.deepEqual(r, { ok: true, status: 'dispatched', skipped: false });
  assert.deepEqual(ok.calls, [{ table: 'loads', row: { status: 'dispatched' }, eqs: [['id', 'L1'], ['status', 'booked']] }]);
  for (const st of ['dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled']) {
    const idle = ownerSb({ data: { status: st }, error: null });
    const skipped = await dispatchLoad(idle.sb, { id: 'L1', status: st, channel: 'owner' });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.status, st);
    assert.deepEqual(idle.calls, []);
  }
  const denied = ownerSb({ data: null, error: { message: 'row level security' } });
  const bad = await dispatchLoad(denied.sb, { id: 'L1', status: 'booked', channel: 'owner' });
  assert.equal(bad.ok, false);
  const other = await writeOwnerLoadStatus(ok.sb, { id: 'L2', status: 'in_transit' });
  assert.equal(other.ok, true);
  assert.deepEqual(ok.calls.at(-1).eqs, [['id', 'L2']]);
});

test('staff Dispatch uses dispatch_update_load with only the status, and skips when it is not booked', async () => {
  const calls = [];
  const saveStaff = async (sb, id, patch) => { calls.push({ id, patch, sb }); return { ok: true, load: { status: 'dispatched' } }; };
  const sb = { from: () => { throw new Error('staff dispatch must not update loads directly'); } };
  const r = await dispatchLoad(sb, { id: 'L9', status: 'booked', channel: 'staff', saveStaff });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [{ id: 'L9', patch: { status: 'dispatched' }, sb }]);
  calls.length = 0;
  const skipped = await dispatchLoad(sb, { id: 'L9', status: 'in_transit', channel: 'staff', saveStaff });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(calls, []);
  const blocked = await dispatchLoad(sb, { id: 'L9', status: 'booked', channel: 'staff' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /management and dispatchers/);
});

test('dispatch edit: assigning on a booked load adds status dispatched; reassign and unassign do not', () => {
  const booked = { ...base, status: 'booked', assigned_driver_user_id: null };
  const assigned = formToPatch({ ...loadToForm(booked), assigned_driver_user_id: D1 }, booked);
  assert.equal(assigned.patch.status, 'dispatched');
  assert.equal(assigned.patch.assigned_driver_user_id, D1);
  const reassigned = formToPatch({ ...loadToForm({ ...booked, status: 'dispatched', assigned_driver_user_id: D1 }), assigned_driver_user_id: D2 }, { ...booked, status: 'dispatched', assigned_driver_user_id: D1 });
  assert.equal(reassigned.patch.assigned_driver_user_id, D2);
  assert.equal(reassigned.patch.status, undefined);
  const unassigned = formToPatch({ ...loadToForm({ ...booked, status: 'dispatched', assigned_driver_user_id: D1 }), assigned_driver_user_id: '' }, { ...booked, status: 'dispatched', assigned_driver_user_id: D1 });
  assert.equal(unassigned.patch.assigned_driver_user_id, null);
  assert.equal(unassigned.patch.status, undefined);
  const transit = formToPatch({ ...loadToForm({ ...booked, status: 'in_transit' }), assigned_driver_user_id: D1 }, { ...booked, status: 'in_transit' });
  assert.equal(transit.patch.status, undefined);
  const cancelled = formToPatch({ ...loadToForm(booked), assigned_driver_user_id: D1, status: 'cancelled' }, booked);
  assert.equal(cancelled.patch.status, 'cancelled');
  const manual = formToPatch({ ...loadToForm(booked), status: 'dispatched' }, booked);
  assert.equal(manual.patch.status, 'dispatched');
  assert.equal(manual.patch.assigned_driver_user_id, undefined);
});

test('dispatch create and owner create: a driver dispatches; load boards save still has no driver', () => {
  const created = formToNewLoad({ ...loadToForm({}), rate: '1', broker_name: 'Demo (FAKE)', assigned_driver_user_id: D1 });
  assert.equal(created.load.status, 'dispatched');
  assert.equal(created.load.assigned_driver_user_id, D1);
  const later = formToNewLoad({ ...loadToForm({}), rate: '1', broker_name: 'Demo (FAKE)', status: 'in_transit', assigned_driver_user_id: D1 });
  assert.equal(later.load.status, 'in_transit');
  const plain = formToNewLoad({ ...loadToForm({}), rate: '1', broker_name: 'Demo (FAKE)' });
  assert.equal(plain.load.status, 'booked');
  assert.equal(plain.load.assigned_driver_user_id, undefined);
  const good = { ...EMPTY_NEW_LOAD, rate: '1000', pu_city: 'Dallas', pu_state: 'TX', del_city: 'Austin', del_state: 'TX' };
  assert.equal(buildNewLoad(good, { userId: 'u' }).load.status, 'booked');
  assert.equal(buildNewLoad({ ...good, driver_user_id: D1 }, { userId: 'u' }).load.status, 'dispatched');
  const board = buildBoardLoad({ ...EMPTY_BOARD_FORM, board: 'dat', broker_name: 'Demo (FAKE)', rate: '100' }, { userId: 'u' });
  assert.equal(board.load.status, 'booked');
  assert.equal(board.load.assigned_driver_user_id, undefined);
});

test('createLoad RPC and the owner insert both send dispatched when the load has a driver', async () => {
  const calls = [];
  const sb = { rpc: async (fn, args) => { calls.push({ fn, args }); return { data: 'aaaaaaaa-0000-0000-0000-000000000001', error: null }; } };
  const r = await createLoad(sb, 'owner-1', { rate: 10, status: 'booked', assigned_driver_user_id: D1 }, []);
  assert.equal(r.ok, true);
  assert.equal(calls[0].args.p_load.status, 'dispatched');
  assert.equal(calls[0].args.p_load.assigned_driver_user_id, D1);
  const kept = await createLoad(sb, 'owner-1', { rate: 10, status: 'cancelled', assigned_driver_user_id: D1 }, []);
  assert.equal(kept.ok, true);
  assert.equal(calls[1].args.p_load.status, 'cancelled');
  const owner = { calls: [], from: (t) => ({ insert: (row) => { owner.calls.push([t, row]); return { select: () => ({ single: async () => ({ data: { id: 'L', ...row }, error: null }) }) }; }, delete: () => ({ eq: async () => ({ error: null }) }) }) };
  const made = await createManualLoad(owner, { load: { user_id: 'u', status: 'booked', rate: 1, assigned_driver_user_id: D1 }, stops: [] });
  assert.equal(made.ok, true);
  assert.equal(owner.calls[0][1].status, 'dispatched');
});

test('owner driver save dispatches a booked load and does not when the RPC rejects the caller', async () => {
  const updates = [];
  const sb = {
    rpc: async (fn, args) => ({ data: { id: args.p_load, assigned_driver_user_id: args.p_driver, show_rate_to_driver: args.p_show }, error: null }),
    from: () => ({ update: (row) => { const eqs = []; const q = { eq: (k, v) => { eqs.push([k, v]); return q; }, select: () => ({ maybeSingle: async () => { updates.push({ row, eqs }); return { data: { status: row.status }, error: null }; } }) }; return q; } }),
  };
  const saved = await saveDriverSettings(sb, 'L1', { driverId: D1, showRate: false, status: 'booked', previousDriver: null });
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 'dispatched');
  assert.deepEqual(updates[0], { row: { status: 'dispatched' }, eqs: [['id', 'L1'], ['status', 'booked']] });
  updates.length = 0;
  const same = await saveDriverSettings(sb, 'L1', { driverId: D1, showRate: true, status: 'booked', previousDriver: D1 });
  assert.equal(same.status, 'booked');
  assert.deepEqual(updates, []);
  const moved = await saveDriverSettings(sb, 'L1', { driverId: D2, showRate: false, status: 'dispatched', previousDriver: D1 });
  assert.equal(moved.status, 'dispatched');
  assert.deepEqual(updates, []);
  const cleared = await saveDriverSettings(sb, 'L1', { driverId: null, showRate: false, status: 'dispatched', previousDriver: D1 });
  assert.equal(cleared.status, 'dispatched');
  assert.deepEqual(updates, []);
  for (const st of ['in_transit', ...TERMINAL_STATUSES]) {
    const r = await saveDriverSettings(sb, 'L1', { driverId: D1, showRate: false, status: st, previousDriver: null });
    assert.equal(r.status, st);
  }
  assert.deepEqual(updates, []);
  const denied = { rpc: async () => ({ data: null, error: { message: 'not_allowed' } }), from: () => { throw new Error('rejected caller must not write status'); } };
  const no = await saveDriverSettings(denied, 'L1', { driverId: D1, showRate: false, status: 'booked', previousDriver: null });
  assert.equal(no.ok, false);
  assert.match(no.error, /owner, management or a dispatcher/);
});

test('Home shows the map for a dispatched load and not for a booked Next load', () => {
  const stop = (sequence, stop_type) => ({ id: sequence, sequence, stop_type, city: 'Dallas', state: 'TX' });
  const load = (status) => ({ id: '1', status, stops: [stop(1, 'pickup'), stop(2, 'delivery')] });
  assert.equal(pickCurrentLoad([load('booked')]).kind, 'next');
  assert.equal(pickCurrentLoad([load('dispatched')]).kind, 'current');
  const card = read('app/components/HomeCurrentLoad.js');
  assert.match(card, /enabled=\{props\.pick\.kind === 'current'\}/);
});

test('every assign path and both Dispatch buttons call the shared helper', () => {
  const dispatch = read('app/lib/dispatch.js');
  const loadNew = read('app/lib/loadNew.js');
  const driver = read('app/lib/loadDriver.js');
  const ownerPage = read('app/loads/[id]/page.js');
  const staffPage = read('app/dispatch/[id]/page.js');
  const settings = read('app/components/LoadDriverSettings.js');
  const boards = read('app/dispatch/boards/page.js');
  assert.match(dispatch, /statusAfterDriverChange\(/);
  assert.match(dispatch, /statusForNewAssignedLoad\(/);
  assert.match(loadNew, /statusForNewAssignedLoad\(/);
  assert.match(driver, /dispatchLoad\(/);
  assert.match(ownerPage, /dispatchLoad\(supabase, \{ id, status: prev, channel: 'owner' \}\)/);
  assert.match(ownerPage, /writeOwnerLoadStatus\(/);
  assert.match(ownerPage, /hasStatus && owner && \(/);
  assert.match(ownerPage, /data-testid="dispatch-load-btn"/);
  assert.match(ownerPage, /minHeight: 44/);
  assert.match(staffPage, /channel: 'staff', saveStaff: saveLoad/);
  assert.match(staffPage, /data-testid="dispatch-load-btn"/);
  assert.match(staffPage, /minHeight: 44/);
  assert.match(staffPage, /formStatusOnDriverPick\(/);
  assert.match(staffPage, /formStatusOnStatusPick\(/);
  assert.match(read('app/dispatch/new/page.js'), /formStatusOnDriverPick\(/);
  assert.match(read('app/dispatch/new/page.js'), /formStatusOnStatusPick\(/);
  assert.match(settings, /status: load\.status, previousDriver: load\.assigned_driver_user_id/);
  assert.match(read('app/dispatch/new/page.js'), /formToNewLoad\(/);
  assert.match(read('app/loads/new/page.js'), /buildNewLoad\(/);
  assert.doesNotMatch(boards, /assigned_driver_user_id/);
  assert.doesNotMatch(read('app/lib/loadBoards.js'), /assigned_driver_user_id/);
});
