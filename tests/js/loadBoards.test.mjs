import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOAD_BOARDS, OTHER_BOARD, boardLabel, boardNoteLine, boardFromNotes, notesWithBoard, buildBoardLoad, createBoardLoad, boardLoads } from '../../app/lib/loadBoards.js';
import { blankStop, formToStops } from '../../app/lib/dispatch.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('config: the four boards with their verified https URLs, labelled plainly', () => {
  assert.deepEqual(LOAD_BOARDS.map((b) => [b.label, b.url]), [
    ['DAT One', 'https://one.dat.com'],
    ['Truckstop', 'https://app.truckstop.com'],
    ['Uber Freight', 'https://www.uberfreight.com/en-US/login'],
    ['Freight Link (FreightLink Solutions, unconfirmed)', 'https://freightlinksolutions.net'],
  ]);
  for (const b of LOAD_BOARDS) { assert.ok(new URL(b.url).protocol === 'https:'); assert.ok(b.key && b.label); }
  assert.equal(new Set(LOAD_BOARDS.map((b) => b.key)).size, LOAD_BOARDS.length);
});
test('board URLs live only in the config file', () => {
  const page = read('app/dispatch/boards/page.js');
  for (const b of LOAD_BOARDS) assert.ok(!page.includes(b.url), b.url);
});

test('source board = first line of notes, round-trips; other notes stay intact', () => {
  assert.equal(boardNoteLine('DAT One'), 'Load board: DAT One');
  assert.equal(notesWithBoard('DAT One', ''), 'Load board: DAT One');
  const n = notesWithBoard('Truckstop', 'Call before 5 PM\nDock 4');
  assert.equal(n, 'Load board: Truckstop\nCall before 5 PM\nDock 4');
  assert.deepEqual(boardFromNotes(n), { board: 'Truckstop', rest: 'Call before 5 PM\nDock 4' });
  assert.deepEqual(boardFromNotes('Just notes'), { board: null, rest: 'Just notes' });
  assert.deepEqual(boardFromNotes(null), { board: null, rest: '' });
  assert.equal(boardLabel(OTHER_BOARD, '  Test Board  '), 'Test Board');
  assert.equal(boardLabel('dat'), 'DAT One');
});

test('form: required board, broker and rate; numbers checked; builds the owner load', () => {
  const bad = buildBoardLoad({ board: '', broker_name: '', rate: 'abc', weight: '-1' }, { userId: 'u1' });
  assert.equal(bad.load, null);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['board', 'broker_name', 'rate', 'weight']);
  assert.ok(buildBoardLoad({ board: OTHER_BOARD, broker_name: 'B', rate: '1' }).errors.board_other);
  const ok = buildBoardLoad({ board: 'dat', broker_name: ' Acme Test Logistics ', broker_load_number: 'TEST-1', rate: '$2,450', miles: '355', weight: '38,000', notes: 'Fake note' }, { userId: 'owner-1' });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.load, { user_id: 'owner-1', status: 'booked', broker_name: 'Acme Test Logistics', broker_load_number: 'TEST-1', rate: 2450,
    commodity: null, weight: 38000, equipment_type: null, notes: 'Load board: DAT One\nFake note', total_miles: 355, miles_source: 'typed' });
});

test('stops: reuses dispatch formToStops (2–20, needs a pickup and a delivery)', () => {
  const one = [blankStop('pickup', 'America/Chicago')];
  assert.ok(formToStops(one).errors._list);
  const two = [{ ...blankStop('pickup', 'America/Chicago'), city: 'Joliet', state: 'IL', pickup_number: 'PU-1' }, { ...blankStop('delivery', 'America/Chicago'), city: 'Columbus', state: 'OH' }];
  const r = formToStops(two);
  assert.equal(r.payload.length, 2); assert.equal(r.payload[0].pickup_number, 'PU-1');
  assert.ok(formToStops(Array.from({ length: 21 }, (_, i) => ({ ...blankStop(i ? 'delivery' : 'pickup'), city: 'X' }))).errors._list);
});

function fakeSb({ insertError = null } = {}) {
  const calls = [];
  return { calls, from: (t) => ({
    insert: (row) => { calls.push(['insert', t, row]); return { select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: 'L1' }, error: null }) }) }; },
    delete: () => ({ eq: async (k, v) => { calls.push(['delete', t, v]); return { error: null }; } }),
  }) };
}
test('save: insert the load, then dispatch_save_stops; failed stops delete the load again', async () => {
  const sb = fakeSb();
  const stops = [{ stop_type: 'pickup', city: 'A' }, { stop_type: 'delivery', city: 'B' }];
  const ok = await createBoardLoad(sb, { load: { user_id: 'o', notes: 'Load board: DAT One' }, stops }, { saveStops: async (_s, id, p) => { sb.calls.push(['stops', id, p.length]); return { ok: true }; } });
  assert.deepEqual(ok, { ok: true, id: 'L1' });
  assert.deepEqual(sb.calls.map((c) => c[0]), ['insert', 'stops']);
  const sb2 = fakeSb();
  const bad = await createBoardLoad(sb2, { load: { user_id: 'o' }, stops }, { saveStops: async () => ({ ok: false, error: 'A load needs at least one delivery.' }) });
  assert.equal(bad.ok, false); assert.match(bad.error, /not saved/);
  assert.deepEqual(sb2.calls.map((c) => c[0]), ['insert', 'delete']);
  const sb3 = fakeSb({ insertError: { message: 'column "miles_source" does not exist' } });
  const r3 = await createBoardLoad(sb3, { load: { user_id: 'o', miles_source: 'typed' }, stops }, { saveStops: async () => ({ ok: true }) });
  assert.equal(r3.ok, false); assert.equal(sb3.calls.length, 2); assert.ok(!('miles_source' in sb3.calls[1][2]), 'retried without miles_source');
});

test('list: only loads with a board line, newest first', () => {
  const out = boardLoads([{ id: 1, notes: 'x', created_at: '2026-10-18' }, { id: 2, notes: 'Load board: DAT One', created_at: '2026-10-17' }, { id: 3, notes: 'Load board: Truckstop\nn', created_at: '2026-10-19' }]);
  assert.deepEqual(out.map((l) => [l.id, l.board]), [[3, 'Truckstop'], [2, 'DAT One']]);
});

test('page: owner, management and dispatchers can save (owner via RLS insert, staff via dispatch_create_load), header links, shared stops editor', () => {
  const page = read('app/dispatch/boards/page.js');
  assert.match(page, /const canSave = state\.role === 'owner' \|\| \(\(state\.role === 'management' \|\| state\.role === 'dispatcher'\) && !!state\.company\?\.owner_id\);/);
  assert.match(page, /<fieldset disabled=\{!canSave\}/);
  assert.doesNotMatch(page, /boards-disabled-note/);
  assert.match(page, /data-testid="boards-owner-note"/);
  assert.match(page, /createLoad\(supabase, state\.company\.owner_id, b\.load, st\.payload\)/);
  assert.match(page, /router\.push\(loadHref\(r\.id\)\)/);
  assert.match(page, /disabled=\{!canSave \|\| saving\}/);
  assert.match(page, /<StopsEditor stops=\{stops\}[^\n]*disabled=\{!canSave\} testId="board-stops"/);
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /companyOwnerStatus\(supabase, u\.id\)/);
  assert.match(page, /createBoardLoad\(supabase, \{ load: b\.load, stops: st\.payload \}, \{ saveStops \}\)/);
  assert.match(read('app/dispatch/page.js'), /<DispatchHeaderLinks active="loads" \/>/);
  assert.match(read('app/dispatch/DispatchHeaderLinks.js'), /href="\/dispatch\/boards"/);
  assert.match(read('app/dispatch/[id]/page.js'), /<StopsEditor stops=\{stops\} setStops=\{setStops\} stopErrors=\{stopErrors\} browserTz=\{browserTz\} onEdit=\{\(\) => setMsg\(null\)\} \/>/);
});

// QA #98 r1
import { loadsLinkHref } from '../../app/lib/loadBoards.js';
import { addStop, blankStop as _blank } from '../../app/lib/dispatch.js';
import { readFileSync as _rf } from 'node:fs';
const _src = (p) => _rf(new URL(`../../${p}`, import.meta.url), 'utf8');

test('header Loads link: owners go to /loads, management and dispatchers to /dispatch', () => {
  assert.equal(loadsLinkHref('owner'), '/loads');
  assert.equal(loadsLinkHref('dispatcher'), '/dispatch');
  assert.equal(loadsLinkHref('management'), '/dispatch');
  assert.equal(loadsLinkHref(undefined), null);
  assert.equal(loadsLinkHref(null), null);
  assert.equal(loadsLinkHref('none'), '/dispatch');
  const hl = _src('app/dispatch/DispatchHeaderLinks.js');
  assert.match(hl, /const loadsHref = active === 'loads' \? '\/dispatch' : loadsLinkHref\(role\);/);
  assert.match(hl, /aria-disabled="true"/);
  assert.doesNotMatch(hl, /href="\/dispatch"/);
  // Boards first render: state is { status: 'loading' } (no role), so no Loads href is sent from the server.
  assert.match(_src('app/dispatch/boards/page.js'), /useState\(\{ status: 'loading' \}\)/);
  assert.match(_src('app/dispatch/DispatchHeaderLinks.js'), /href=\{loadsHref\}/);
  assert.match(_src('app/dispatch/boards/page.js'), /<DispatchHeaderLinks active="boards" role=\{state\.role\} \/>/);
});

test('addStop: pickup goes before the first delivery, delivery appends', () => {
  const types = (l) => l.map((x) => x.stop_type).join(',');
  const base = [_blank('pickup'), _blank('delivery'), _blank('delivery')];
  assert.equal(types(addStop(base, 'pickup')), 'pickup,pickup,delivery,delivery');
  assert.equal(types(addStop(base, 'delivery')), 'pickup,delivery,delivery,delivery');
  assert.equal(types(addStop([_blank('pickup')], 'pickup')), 'pickup,pickup');
  assert.equal(types(addStop([], 'pickup')), 'pickup');
  assert.equal(types(addStop([_blank('delivery')], 'pickup')), 'pickup,delivery');
  const mixed = [_blank('pickup'), _blank('delivery'), _blank('pickup')]; // user-reordered: still before the first delivery
  assert.equal(addStop(mixed, 'pickup', 'America/Chicago')[1].timezone, 'America/Chicago');
  assert.equal(base.length, 3); // no mutation
  const ed = _src('app/components/StopsEditor.js');
  assert.match(ed, /addStop\(l, 'pickup'/); assert.match(ed, /addStop\(l, 'delivery'/);
});

test('placeholders read as examples, and no-appointment rows say so', () => {
  assert.match(_src('app/components/StopsEditor.js'), /placeholder="e\.g\. CA"/);
  const p = _src('app/dispatch/boards/page.js');
  assert.match(p, /placeholder="e\.g\. 1,280"/); assert.match(p, /placeholder="e\.g\. 53' dry van"/);
  assert.match(p, /'Pickup date not set'/); assert.doesNotMatch(p, /Pickup \{fmtDay/);
});

import { showDispatchNav } from '../../app/lib/loadBoards.js';
test('dispatch section nav: hidden for drivers / non-members, unchanged for owner, management, dispatcher', () => {
  for (const r of ['owner', 'management', 'dispatcher', undefined]) assert.equal(showDispatchNav(r), true, String(r));
  for (const r of ['none', 'driver']) assert.equal(showDispatchNav(r), false, r);
  const p = _src('app/dispatch/boards/page.js');
  assert.match(p, /\{showDispatchNav\(state\.role\) && <DispatchHeaderLinks active="boards" role=\{state\.role\} \/>\}/);
  assert.match(p, /data-testid="boards-not-member">[^\n]*<Link href="\/"[^>]*>Home<\/Link>/);
});
