import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext, loginHref, DEFAULT_NEXT } from '../../app/lib/safeNext.js';

test('safeNext: same-site paths pass through', () => {
  assert.equal(safeNext('/loads/123?x=1'), '/loads/123?x=1');
  assert.equal(safeNext('/documents'), '/documents');
  assert.equal(safeNext('/loads/123?x=1#stops'), '/loads/123?x=1#stops');
  assert.equal(safeNext('%2Floads%2F123%3Fx%3D1'), '/loads/123?x=1');
});
test('safeNext: protocol-relative and backslash tricks are refused', () => {
  for (const v of ['//evil.com', '/\\evil.com', '\\\\evil.com', '/\\/evil.com', '///evil.com', '/%2Fevil.com', '%2F%2Fevil.com', '/%5Cevil.com', '%2F%5Cevil.com', '%252F%252Fevil.com', '/%09/evil.com', '/\t/evil.com', '/foo\\bar', '/..//evil.com', '/%2e%2e//evil.com', '/./%2F/evil.com'])
    assert.equal(safeNext(v), DEFAULT_NEXT, v);
});
test('safeNext: schemes refused (plain and encoded)', () => {
  for (const v of ['https://evil.com', 'http://evil.com/x', 'HTTPS://evil.com', 'javascript:alert(1)', 'JavaScript:alert(1)', 'javascript%3Aalert(1)', 'data:text/html,hi', 'https%3A%2F%2Fevil.com', ' javascript:alert(1)'])
    assert.equal(safeNext(v), DEFAULT_NEXT, v);
});
test('safeNext: /login itself, empty, junk -> fallback', () => {
  for (const v of ['/login', '/login?next=/x', '/login/', '%2Flogin', '', null, undefined, 42, 'loads', '%E0%A4%A', 'evil.com'])
    assert.equal(safeNext(v), DEFAULT_NEXT, String(v));
  assert.equal(safeNext('//evil.com', '/x'), '/x');
  assert.equal(safeNext('/loginx'), '/loginx');
});
test('loginHref: encodes the current path, plain /login when not safe', () => {
  assert.equal(loginHref('/loads/123?x=1'), '/login?next=%2Floads%2F123%3Fx%3D1');
  assert.equal(loginHref('/login'), '/login');
  assert.equal(loginHref('//evil.com'), '/login');
});
test('safeNext: backslash anywhere (raw, %5C, %5c, %255C) refused', () => {
  for (const v of ['/loads\\123', '/loads/1?x=\\', '/a%5Cb', '/a%5cb', '/a%255Cb', '/a%255cb', '/%5C/evil.com', '/%255C%255Cevil.com'])
    assert.equal(safeNext(v), DEFAULT_NEXT, v);
});
test('safeNext: control chars, tabs, newlines (raw and encoded) refused', () => {
  for (const v of ['/%09/evil.com', '/%0A/evil.com', '/%0D/evil.com', '/%0a/evil.com', '/%0d%0a/x', '/\n/evil.com', '/\r/evil.com', '/\t/evil.com', '/a%00b', '/a%7Fb', '/a%2509b', '/loads/1?x=%0A'])
    assert.equal(safeNext(v), DEFAULT_NEXT, JSON.stringify(v));
});
test('safeNext: malformed encoding (decode throws) refused', () => {
  for (const v of ['/%', '/%E0%A4%A', '/a%ZZ', '/%25%'])
    assert.equal(safeNext(v), DEFAULT_NEXT, v);
});
