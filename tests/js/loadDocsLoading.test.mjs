import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('Documents panels show Loading during a re-fetch instead of "No linked documents"', () => {
  const page = read('../../app/loads/[id]/page.js');
  assert.match(page, /docs\.length === 0 && docsBusy \? <p style=\{s\.muted\} data-testid="load-docs-loading">Loading documents…/);
  assert.match(page, /\]\)\.finally\(\(\) => setDocsBusy\(false\)\);/);
  const card = read('../../app/components/LoadDocsCard.js');
  assert.match(card, /docs === null \|\| \(busy && docs\.length === 0\) \? <p/);
});
