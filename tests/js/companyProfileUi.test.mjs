import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const page = readFileSync(new URL('../../app/company/page.js', import.meta.url), 'utf8');
const fields = readFileSync(new URL('../../app/lib/companyFields.js', import.meta.url), 'utf8');

test('company page never pulls server crypto into the client bundle', () => {
  assert.ok(!/packetCrypto|companyProfile'|node:crypto/.test(page));
  assert.ok(!/node:crypto|packetCrypto/.test(fields));
});
test('signature file input is iOS-safe', () => {
  assert.match(page, /<input id=\{SIG_INPUT\} type="file"[^>]*style=\{VISUALLY_HIDDEN\}/);
  assert.match(page, /<label htmlFor=\{SIG_INPUT\}/);
  assert.ok(!/display:\s*['"]?none/.test(page));
  assert.ok(!/\.click\(\)/.test(page));
});
test('edit and sign are role-gated; drivers get read-only', () => {
  assert.match(page, /const editable = roleCanEdit\(role\)/);
  assert.match(page, /const signable = roleCanSign\(role\)/);
  assert.match(page, /\{signable && \(/);
  assert.match(page, /\{editable && <button type="submit"/);
  assert.match(page, /Drivers can view the company profile/);
});
test('account menu links to the company profile', () => {
  const m = readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');
  assert.match(m, /href="\/company"/);
  assert.match(m, /itemRefs\.current\[3\]/);
});
