// Document created dates: a UTC instant in the evening must show the viewer's local calendar day.
// The suite runs with TZ=America/Los_Angeles. Chicago is passed in so the helper is not stuck on the process zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatLocalDate, localISODate } from '../../app/lib/localDate.js';
import { loadLinkLabel, loadPickLabel } from '../../app/lib/loadDocs.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('2026-10-26T00:20:00Z is 10/25 in America/Chicago', () => {
  assert.equal(formatLocalDate('2026-10-26T00:20:00Z', 'America/Chicago'), '10/25/2026');
  assert.match(formatLocalDate('2026-10-26T00:20:00Z', 'America/Chicago'), /10\/25/);
});

test('a bare UTC timestamp (no zone) is the same Chicago day, not the UTC date', () => {
  // Postgres can drop the offset. new Date("2026-10-26 00:20:00") would keep 10/26.
  assert.equal(formatLocalDate('2026-10-26 00:20:00', 'America/Chicago'), '10/25/2026');
  assert.equal(formatLocalDate('2026-10-26T00:20:00', 'America/Chicago'), '10/25/2026');
});

test('with no zone argument the date follows the runtime timezone (America/Los_Angeles here)', () => {
  assert.equal(formatLocalDate('2026-10-26T00:20:00Z'), '10/25/2026');
  assert.equal(formatLocalDate('2026-10-26T07:00:00Z'), '10/26/2026');
});

test('empty and unreadable values stay blank', () => {
  assert.equal(formatLocalDate(''), '');
  assert.equal(formatLocalDate(null), '');
  assert.equal(formatLocalDate('not-a-date'), '');
});

test('an unknown timezone falls back to the runtime zone', () => {
  assert.equal(formatLocalDate('2026-10-26T00:20:00Z', 'Not/AZone'), '10/25/2026');
});

test('a load label uses the Chicago day for an evening Central created_at, not the next UTC day', () => {
  const created_at = '2026-10-26T00:20:00Z';
  assert.equal(formatLocalDate(created_at, 'UTC'), '10/26/2026');
  assert.equal(
    loadPickLabel({ broker_load_number: 'TEST-PICS-2', broker_name: 'Fake Broker', created_at }, 'America/Chicago'),
    '#TEST-PICS-2 · Fake Broker (10/25/2026)',
  );
  // 1:30am in Chicago is still the previous evening in Los Angeles, so the zone argument has to be honored.
  assert.equal(
    loadPickLabel({ broker_load_number: 'TEST-PICS-2', broker_name: 'Fake Broker', created_at: '2026-10-26T06:30:00Z' }, 'America/Chicago'),
    '#TEST-PICS-2 · Fake Broker (10/26/2026)',
  );
  assert.equal(
    loadPickLabel({ broker_load_number: 'TEST-PICS-2', broker_name: 'Fake Broker', pickup_date: '2026-10-26', created_at }, 'America/Chicago'),
    '#TEST-PICS-2 · Fake Broker (10/26)',
  );
  const src = read('../../app/lib/loadDocs.js');
  assert.match(src, /formatLocalDate\(/);
  assert.doesNotMatch(src, /toLocaleDateString/);
  assert.equal(localISODate(created_at, 'America/Chicago'), '2026-10-25');
  assert.equal(localISODate('2026-10-26'), '2026-10-26');
  assert.equal(
    loadLinkLabel({ load_label: '#TEST-PICS-2 · Fake Broker (10/26/2026)', load_created_at: created_at }, 'America/Chicago'),
    '#TEST-PICS-2 · Fake Broker (10/25/2026)',
  );
  assert.equal(
    loadLinkLabel({ load_label: '#TEST-PICS-2 · Fake Broker (10/26)', load_created_at: created_at }, 'America/Chicago'),
    '#TEST-PICS-2 · Fake Broker (10/26)',
  );
  for (const file of ['../../app/documents/vault/page.js', '../../app/components/TeamDocsList.js']) {
    assert.match(read(file), /loadLinkLabel\(/, file);
  }
  for (const file of ['../../app/api/documents/vault/route.js', '../../app/api/documents/team/route.js']) {
    assert.match(read(file), /load_created_at/, file);
  }
});

test('load document and picture rows format created_at in local time', () => {
  const files = [
    '../../app/loads/[id]/page.js',
    '../../app/components/LoadDocsCard.js',
    '../../app/documents/vault/page.js',
    '../../app/components/TeamDocsList.js',
    '../../app/documents/page.js',
    '../../app/documents/drivers/page.js',
    '../../app/components/LoadPictures.js',
  ];
  for (const file of files) {
    const src = read(file);
    assert.match(src, /formatLocalDate\(/, file);
    assert.doesNotMatch(src, /new Date\([^)]*created_at[^)]*\)\.toLocaleDateString\(\)/, file);
  }
});

test('picture tiles keep a gray placeholder until the image loads', () => {
  const ui = read('../../app/components/LoadPictures.js');
  assert.match(ui, /background: 'var\(--surface-2\)'/);
  assert.match(ui, /height: 104/);
  assert.match(ui, /minHeight: 44/);
  assert.match(ui, /loading="lazy"/);
  assert.match(ui, /onLoad=/);
  assert.match(ui, /opacity: phase === 'ready' \? 1 : 0/);
  assert.match(ui, /transition: 'opacity/);
  assert.match(ui, /Couldn&apos;t load/);
  assert.match(ui, /formatLocalDate\(pic\.created_at\)/);
});
