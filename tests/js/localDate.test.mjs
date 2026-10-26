// Document created dates: a UTC instant in the evening must show the viewer's local calendar day.
// The suite runs with TZ=America/Los_Angeles. Chicago is passed in so the helper is not stuck on the process zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatLocalDate } from '../../app/lib/localDate.js';

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
