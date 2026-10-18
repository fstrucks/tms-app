// Sign-in button with autofill / password managers / paste (Taylor, found on #70). FAKE credentials only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCredentials, validateCredentials, submitDisabled } from '../../app/lib/loginForm.js';

// A <form> whose inputs were filled by autofill: the DOM has the values, React state never saw an onChange.
const form = (vals) => ({ elements: { namedItem: (n) => (n in vals ? { value: vals[n] } : null) } });

test('autofill/paste: values filled without onChange are read from the form at submit', () => {
  const c = readCredentials(form({ email: ' test.driver@example.test ', password: 'fake-Passw0rd' }), { email: '', password: '' });
  assert.deepEqual(c, { email: 'test.driver@example.test', password: 'fake-Passw0rd' });
  assert.equal(validateCredentials(c, true), null);
});
test('falls back to React state when there is no form element; magic-link mode needs no password', () => {
  assert.deepEqual(readCredentials(null, { email: 'a@example.test', password: 'x' }), { email: 'a@example.test', password: 'x' });
  assert.deepEqual(readCredentials(form({ email: 'a@example.test' }), { password: 'typed' }), { email: 'a@example.test', password: 'typed' });
  assert.equal(validateCredentials({ email: 'a@example.test', password: '' }, false), null);
});
test('empty or bad fields are explained on submit instead of a silently disabled button', () => {
  assert.equal(validateCredentials({ email: '', password: '' }, true), 'Enter your email and password.');
  assert.equal(validateCredentials({ email: '', password: '' }, false), 'Enter your email.');
  assert.equal(validateCredentials({ email: 'not-an-email', password: 'x' }, true), 'Enter a valid email address.');
  assert.equal(validateCredentials({ email: 'a@example.test', password: '' }, true), 'Enter your password.');
});
test('button: only disabled while signing in, never because the fields look empty to React', () => {
  assert.equal(submitDisabled(false), false); assert.equal(submitDisabled(true), true);
  const src = readFileSync('app/login/page.js', 'utf8');
  assert.match(src, /<button type="submit" disabled=\{!hydrated \|\| submitDisabled\(sending\)\}/);
  assert.doesNotMatch(src, /disabled=\{sending \|\| !email/);
  assert.match(src, /readCredentials\(e\.currentTarget, \{ email, password \}\)/);
  assert.match(src, /<input id="email" name="email"/); assert.match(src, /<input id="password" name="password"/);
  assert.match(src, /onInput=\{\(e\) => setPassword\(e\.currentTarget\.value\)\}/);
  assert.match(src, /signInWithPassword\(c\), \{ email: em, password: pw \}/);
});

test('both fields empty → our plain "Enter your email and password." message (browser tip suppressed with noValidate)', () => {
  const src = readFileSync('app/login/page.js', 'utf8');
  assert.match(src, /<form method="post" action=\{fallbackAction\('\/login'\)\} onSubmit=\{handleSubmit\} noValidate/);
  assert.match(src, /const invalid = validateCredentials\(creds, usePw\);\n\s*if \(invalid\) return setError\(invalid\);/);
  assert.match(src, /<p id="login-error" role="alert" aria-live="assertive"/); // the message is announced and shown
  assert.equal(validateCredentials(readCredentials(form({ email: '', password: '' })), true), 'Enter your email and password.');
  assert.equal(validateCredentials(readCredentials(form({ email: '   ', password: '' })), true), 'Enter your email and password.');
  assert.equal(validateCredentials({ email: 'nope', password: '' }, true), 'Enter a valid email address and your password.');
});
