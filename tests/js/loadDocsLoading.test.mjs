import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

import { docsPanelState } from '../../app/lib/loadDocsClient.js';

test('docsPanelState: loading until the first fetch resolves; empty only after a completed fetch', () => {
  assert.equal(docsPanelState(null, false), 'loading');
  assert.equal(docsPanelState(undefined, false), 'loading');
  assert.equal(docsPanelState([], true), 'loading');
  assert.equal(docsPanelState([], false), 'empty');
  assert.equal(docsPanelState([{ id: 1 }], true), 'list');
});

test('every "No linked documents" render goes through docsPanelState; docs start null and reset per load', () => {
  const page = read('../../app/loads/[id]/page.js');
  assert.match(page, /const \[docs, setDocs\] = useState\(null\)/);
  assert.match(page, /useEffect\(\(\) => \{\n    setDocs\(null\);/);
  assert.match(page, /docsPanelState\(docs, docsBusy\) === 'loading' \? <p style=\{s\.muted\} data-testid="load-docs-loading">Loading documents…/);
  assert.match(page, /docsPanelState\(docs, docsBusy\) === 'empty' \? <p style=\{s\.muted\}>No linked documents/);
  // docs are set right after the fetch, before the expenses / mileage counts
  assert.ok(page.indexOf('if (!de) setDocs(d || []);') < page.indexOf("from('expenses')"));
  const card = read('../../app/components/LoadDocsCard.js');
  assert.match(card, /useEffect\(\(\) => \{ setDocs\(null\); setErr\(null\); refresh\(\); \}, \[loadId\]\)/);
  assert.match(card, /docsPanelState\(docs, busy\) === 'loading'/);
  assert.match(card, /docsPanelState\(docs, busy\) === 'empty' \? <p[^>]*>No linked documents/);
});
