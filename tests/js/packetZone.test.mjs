// One time zone for the whole load packet (Taylor's QA of #153). Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packetZone, zoneAbbr, stopTimeRows } from '../../app/lib/stopTimesPdf.js';

const load = { broker_load_number: 'TEST-1', stops: [
  { id: 's1', sequence: 1, stop_type: 'pickup', state: 'CA', timezone: 'America/Los_Angeles', completed_at: '2026-10-20T15:00:00Z' },
  { id: 's2', sequence: 2, stop_type: 'delivery', state: 'TX', completed_at: '2026-10-21T15:00:00Z' }] };

test('packetZone: valid browser zone, else company zone, else America/Chicago', () => {
  assert.equal(packetZone('America/New_York'), 'America/New_York');
  assert.equal(packetZone('Not/AZone', { timezone: 'America/Denver' }), 'America/Denver');
  assert.equal(packetZone('', null), 'America/Chicago');
  assert.equal(packetZone('<script>', { timezone: 'bad' }), 'America/Chicago');
});

test('packet mode prints every stop in the one zone (no PDT next to CDT)', () => {
  const rows = stopTimeRows(load, { tz: 'America/Chicago', oneZone: true });
  assert.ok(rows.every((r) => /C[DS]T/.test(r.actual)), JSON.stringify(rows.map((r) => r.actual)));
  assert.equal(rows[0].actual, 'Oct 20, 2026, 10:00 AM CDT');
  const own = stopTimeRows(load, { tz: 'America/Chicago' }); // standalone stop-times sheet keeps each stop's own zone
  assert.match(own[0].actual, /PDT/);
});

test('zone label and server wiring', () => {
  assert.equal(zoneAbbr('America/Chicago', new Date('2026-10-20T12:00:00Z')), 'CDT');
  assert.equal(zoneAbbr('America/Chicago', new Date('2026-12-20T12:00:00Z')), 'CST');
  const src = readFileSync(new URL('../../app/lib/stopTimesPdf.js', import.meta.url), 'utf8');
  assert.match(src, /All times in \$\{zoneAbbr\(tz, generatedAt\)\}/);
  const srv = readFileSync(new URL('../../app/lib/loadExportServer.js', import.meta.url), 'utf8');
  assert.match(srv, /const zone = packetZone\(tz, profile\)/);
  assert.match(srv, /stopTimesPdf\(load, profile, \{ tz: zone, oneZone: true/);
});
