import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripSensitiveSearch, fallbackTarget, fallbackAction } from '../../app/lib/authFormsCore.js';
import { POST, GET } from '../../app/api/form-fallback/route.js';

function walk(d, out = []) {
  for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, out) : /\.(js|jsx|tsx?)$/.test(f) && out.push(p); }
  return out;
}
const files = walk('app');
// every <form ...> opening tag in a file that has a password/token input or a sign-in email form
const SENSITIVE = /type=(?:"password"|\{[^}]*'password'[^}]*\})|name="(?:password|token)"/;
const formFiles = files.filter((f) => /<form[\s>]/.test(readFileSync(f, 'utf8')) && SENSITIVE.test(readFileSync(f, 'utf8')));

test('found the credential forms (login, set-password)', () => {
  for (const f of ['app/login/page.js', 'app/account/password/page.js']) assert.ok(formFiles.includes(f), f);
});

const ALL = ['app/login/page.js', 'app/account/password/page.js', 'app/forgot-password/page.js', 'app/account/invite/page.js', ...formFiles];
for (const f of [...new Set(ALL)]) {
  test(`${f}: every form posts to the fallback and the submit starts disabled`, () => {
    const src = readFileSync(f, 'utf8');
    const forms = src.match(/<form\b[^>]*>/g) || [];
    assert.ok(forms.length > 0);
    for (const tag of forms) {
      assert.match(tag, /method="post"/, tag);
      assert.match(tag, /action=\{fallbackAction\('\/[a-z/-]+'\)\}/, tag);
    }
    assert.match(src, /useHydrated\(\)/);
    const submits = src.match(/<button type="submit"[^>]*>/g) || [];
    assert.ok(submits.length > 0);
    for (const b of submits) assert.match(b, /disabled=\{!hydrated \|\|/, b);
  });
}

test('stripSensitiveSearch removes password (and the paired email), keeps the rest', () => {
  assert.equal(stripSensitiveSearch('?email=a%40example.com&password=x&next=%2Floads'), '?next=%2Floads');
  assert.equal(stripSensitiveSearch('?password=x'), '');
  assert.equal(stripSensitiveSearch('?email=a%40example.com'), null);
  assert.equal(stripSensitiveSearch('?mode=reset'), null);
  assert.equal(stripSensitiveSearch('?Token=abc&mode=reset'), '?mode=reset');
});

test('fallback target is a fixed allow-list, never an open redirect', () => {
  assert.equal(fallbackTarget('/login'), '/login?nojs=1');
  assert.equal(fallbackTarget('/account/password'), '/account/password?nojs=1');
  assert.equal(fallbackTarget('https://evil.example'), '/login?nojs=1');
  assert.equal(fallbackTarget(null), '/login?nojs=1');
  assert.equal(fallbackAction('/login'), '/api/form-fallback?back=%2Flogin');
});

test('POST to the fallback: 303 back, no body read, no values echoed', async () => {
  let read = false;
  const req = { url: 'https://t.example/api/form-fallback?back=%2Flogin', text: () => { read = true; }, formData: () => { read = true; } };
  const res = await POST(req);
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.equal(loc, 'https://t.example/login?nojs=1');
  assert.doesNotMatch(loc, /password|email/);
  assert.equal(read, false);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await GET({ url: 'https://t.example/api/form-fallback?back=//evil.example' })).headers.get('location'), 'https://t.example/login?nojs=1');
});
