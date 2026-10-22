// Marc 10/15: document-type selector stands out, is big, has no default, and blocks Upload with a red error.
// One Scanner component serves Documents "Scan document" and the load page's Scan BOL/POD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uploadButtonLabel } from '../../app/lib/docTypes.js';

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
const sc = read('../../app/components/scanner/Scanner.js');
const footer = sc.slice(sc.indexOf('<footer'), sc.indexOf('</footer>'));

test('both scanner entry points use the shared Scanner', () => {
  assert.match(read('../../app/documents/page.js'), /import\('\.\.\/components\/scanner\/Scanner'\)/);
  assert.match(read('../../app/loads/[id]/page.js'), /import\('\.\.\/\.\.\/components\/scanner\/Scanner'\)/);
});

test('no default type; placeholder "Choose document type…"', () => {
  assert.match(sc, /const \[docType, setDocType\] = useState\(''\);/);
  assert.match(footer, /<option value="" disabled>Choose document type…<\/option>/);
  assert.equal(uploadButtonLabel(''), 'Upload Document');
});

test('labelled, full width, tall, high contrast, above the action buttons', () => {
  assert.match(footer, /<label htmlFor=\{ids\.type\}[^>]*>Document type<\/label>/);
  assert.match(footer, /<select ref=\{typeRef\} id=\{ids\.type\}/);
  const sel = footer.slice(footer.indexOf('<select ref={typeRef}'), footer.indexOf('</select>'));
  assert.match(sel, /width: '100%', minHeight: 56, fontSize: 17/);
  assert.match(sel, /border: typeErr \? '2px solid (#dc2626|var\(--danger\))' : '2px solid (#1d4ed8|var\(--primary\))'/);
  const type = footer.indexOf('id={ids.type}');
  assert.ok(type < footer.indexOf('htmlFor={ids.camera}'), 'above Add page');
  assert.ok(type < footer.indexOf('htmlFor={ids.choose}'), 'above Choose photo');
  assert.ok(type < footer.indexOf('onClick={tryUpload}'), 'above Upload');
});

test('Add page shrunk: no longer the 2x-wide, 48px button', () => {
  assert.doesNotMatch(footer, /flex: '2 1 60%'/);
  assert.match(footer, /flex: '1 1 40%', fontWeight: 600/);
});

test('Upload uses aria-disabled (not disabled) and looks disabled until a type is picked', () => {
  const b = footer.slice(footer.lastIndexOf('<button', footer.indexOf('onClick={tryUpload}')), footer.indexOf('</button>', footer.indexOf('onClick={tryUpload}')));
  assert.match(b, /aria-disabled=\{uploadOff \|\| undefined\}/);
  assert.doesNotMatch(b, /\sdisabled=/);
  assert.match(b, /opacity: uploadOff \? 0\.5 : 1/);
  assert.match(sc, /const uploadOff = !\(n \|\| pdf\) \|\| !!busy \|\| !docType \|\| \(isOther && !otherDocType\(otherName\)\);/);
  assert.match(b, /onClick=\{tryUpload\}>\{uploadButtonLabel\(docType\)\}/);
});

test('tap Upload without a type: no upload, red selector + message, focus', () => {
  const fn = sc.slice(sc.indexOf('function tryUpload'), sc.indexOf('function close'));
  assert.match(fn, /if \(busy \|\| \(!pages\.length && !pdf\)\) return;/);
  assert.match(fn, /if \(!docType\) \{ setTypeErr\(true\); typeRef\.current\?\.focus\(\); return; \}/);
  assert.ok(fn.indexOf('!docType') < fn.indexOf('save()'), 'checks before save');
  assert.match(footer, /\{typeErr && <p id=\{ids\.typeErr\} role="alert"[^>]*>Pick a document type first<\/p>\}/);
  assert.match(footer, /aria-invalid=\{typeErr \|\| undefined\} aria-describedby=\{typeErr \? ids\.typeErr : undefined\}/);
  assert.match(footer, /onChange=\{\(e\) => \{ const v = e\.target\.value; setDocType\(v\); setTypeErr\(false\);/);
});

test('Other keeps its custom name and is validated on tap', () => {
  assert.match(footer, /\{isOther && \(\s*<label[\s\S]*?<input ref=\{otherRef\}[\s\S]*?maxLength=\{OTHER_MAX\}/);
  const fn = sc.slice(sc.indexOf('function tryUpload'), sc.indexOf('function close'));
  assert.match(fn, /isOther && !otherDocType\(otherName\)\) \{ setMsg[\s\S]*?otherRef\.current\?\.focus\(\)/);
});
