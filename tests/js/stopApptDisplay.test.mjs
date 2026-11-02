// Taylor QA (b): Home showed "12:00 AM PST" for a rate con delivery whose time ("14:00 - 16:00") the create-load RPC
// couldn't parse (saved as the date at local midnight + "Time: …" in notes). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fmtStopAppt, fmtTimeText, noteTime, isDateOnlyAppt } from '../../app/lib/stopAppt.js';

const LA = 'America/Los_Angeles';
const midLA = '2026-11-03T08:00:00Z'; // Nov 3 00:00 PST

test('date-only rate con appointment with a Time note → date + window + zone (not 12:00 AM)', () => {
  const s = { appointment_start: midLA, appointment_end: null, timezone: LA, notes: 'TZ: America/Los_Angeles\nTime: 14:00 - 16:00' };
  assert.equal(fmtStopAppt(s), 'Tue, Nov 3 2:00 PM–4:00 PM PST');
  assert.ok(!/12:00 AM/.test(fmtStopAppt(s)));
});

test('date-only with no time → date only', () => {
  assert.equal(fmtStopAppt({ appointment_start: midLA, timezone: LA, notes: 'TZ: America/Los_Angeles' }), 'Tue, Nov 3');
  assert.equal(fmtStopAppt({ appointment_start: midLA, timezone: LA, notes: null }), 'Tue, Nov 3');
  assert.equal(fmtStopAppt({ appointment_start: '2026-11-03T06:00:00Z', timezone: 'America/Chicago' }), 'Tue, Nov 3', 'midnight in the STOP zone');
});

test('real times unchanged (same as before)', () => {
  assert.equal(fmtStopAppt({ appointment_start: '2026-11-03T22:00:00Z', appointment_end: '2026-11-04T00:00:00Z', timezone: LA }), 'Tue, Nov 3 2:00 PM–4:00 PM PST');
  assert.equal(fmtStopAppt({ appointment_start: '2026-11-03T22:00:00Z', timezone: LA, notes: 'Time: 9-5' }), 'Tue, Nov 3 2:00 PM PST', 'a parsed time wins over notes');
  assert.equal(fmtStopAppt({ appointment_start: midLA, appointment_end: '2026-11-03T10:00:00Z', timezone: LA }), 'Tue, Nov 3 12:00 AM–2:00 AM PST', 'midnight with an end is a real window');
  assert.equal(fmtStopAppt({}), ''); assert.equal(fmtStopAppt(null), '');
});

test('time text: 24h, am/pm, compact, ranges; unparseable kept as written', () => {
  assert.equal(fmtTimeText('14:00 - 16:00'), '2:00 PM–4:00 PM');
  assert.equal(fmtTimeText('0800-1600'), '8:00 AM–4:00 PM');
  assert.equal(fmtTimeText('8am to 3:30 pm'), '8:00 AM–3:30 PM');
  assert.equal(fmtTimeText('12 AM'), '12:00 AM'); assert.equal(fmtTimeText('12pm'), '12:00 PM');
  assert.equal(fmtTimeText('FCFS 7-15'), 'FCFS 7-15');
  assert.equal(fmtTimeText('25:00'), '25:00');
  assert.equal(noteTime('TZ: X\nTime: FCFS'), 'FCFS'); assert.equal(noteTime('Dock 4'), '');
  assert.equal(fmtStopAppt({ appointment_start: midLA, timezone: LA, notes: 'Time: FCFS 7-15' }), 'Tue, Nov 3 FCFS 7-15 PST');
});

test('date-only detection uses the stop zone, incl. DST days', () => {
  assert.ok(isDateOnlyAppt('2026-11-01T05:00:00Z', null, 'America/Chicago')); // Nov 1 00:00 CDT (fall-back day)
  assert.ok(isDateOnlyAppt('2026-03-08T06:00:00Z', null, 'America/Chicago')); // Mar 8 00:00 CST (spring-forward day)
  assert.ok(!isDateOnlyAppt('2026-11-03T08:00:00Z', null, 'America/Chicago'));
});

test('Home card and load page both use the stop formatter', () => {
  assert.match(readFileSync(new URL('../../app/components/HomeCurrentLoad.js', import.meta.url), 'utf8'), /const appt = fmtStopAppt\(stop\)/);
  assert.match(readFileSync(new URL('../../app/loads/[id]/page.js', import.meta.url), 'utf8'), /\{fmtStopAppt\(st\)\}/);
});

test('loads.js imports fmtApptDate locally (a bare re-export left stopSummary with an undefined name)', () => {
  const src = readFileSync(new URL('../../app/lib/loads.js', import.meta.url), 'utf8');
  assert.match(src, /^import \{[^}]*\bfmtApptDate\b[^}]*\} from '\.\/stopAppt';/m);
});
