// Scan document: a dimmed Upload with no type picked shows a short hint (no default type is auto-picked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const sc = strip(readFileSync(new URL('../../app/components/scanner/Scanner.js', import.meta.url), 'utf8'));

test('hint text is shown only while no document type is picked', () => {
  assert.match(sc, /const showTypeHint = !docType && !typeErr && !busy;/);
  assert.match(sc, /\{showTypeHint && <p id=\{ids\.typeHint\} data-testid="scan-type-hint"[^>]*>Pick a document type to upload\.<\/p>\}/);
});

test('hint sits right before the Upload button and describes it', () => {
  const hint = sc.indexOf('data-testid="scan-type-hint"');
  const btn = sc.indexOf('onClick={tryUpload}');
  assert.ok(hint > 0 && btn > hint, 'hint renders before the Upload button');
  assert.ok(!/<button/.test(sc.slice(hint, sc.lastIndexOf('<button', btn))), 'no other button between hint and Upload');
  assert.match(sc, /aria-describedby=\{showTypeHint \? ids\.typeHint : undefined\}[^>]*onClick=\{tryUpload\}/);
  assert.match(sc, /typeHint: `\$\{uid\}-type-hint`/);
});

test('hint is phone-friendly: full row, wraps, existing muted colour', () => {
  const tag = sc.slice(sc.indexOf('data-testid="scan-type-hint"'), sc.indexOf('Pick a document type to upload.'));
  assert.match(tag, /flex: '1 1 100%'/);
  assert.match(tag, /minWidth: 0/);
  assert.match(tag, /overflowWrap: 'anywhere'/);
  assert.match(tag, /var\(--text-muted\)/);
  assert.doesNotMatch(tag, /whiteSpace: 'nowrap'/);
});

test('still no default type, and Upload still needs a type', () => {
  assert.match(sc, /useState\(''\);/);
  assert.match(sc, /const \[docType, setDocType\] = useState\(''\);/);
  assert.match(sc, /const uploadOff = [^\n]*!docType/);
  assert.match(sc, /if \(!docType\) \{ setTypeErr\(true\);/);
});
