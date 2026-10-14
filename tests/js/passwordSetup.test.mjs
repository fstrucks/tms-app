import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePassword, hasPassword, callbackDestination, recoveryRedirect, otpType } from '../../app/lib/passwordSetup.js';

test('validatePassword: length, confirm, blanks', () => {
  assert.match(validatePassword('short', 'short'), /at least 8/);
  assert.match(validatePassword('', ''), /at least 8/);
  assert.match(validatePassword('        ', '        '), /spaces/);
  assert.match(validatePassword('longenough1', 'longenough2'), /match/);
  assert.match(validatePassword('x'.repeat(73), 'x'.repeat(73)), /72/);
  assert.equal(validatePassword('longenough', 'longenough'), null);
});
test('hasPassword uses user_metadata.password_set only', () => {
  assert.equal(hasPassword(null), false);
  assert.equal(hasPassword({ user_metadata: {} }), false);
  assert.equal(hasPassword({ user_metadata: { password_set: 'yes' } }), false);
  assert.equal(hasPassword({ user_metadata: { password_set: true } }), true);
});
test('callbackDestination: recovery always goes to reset form', () => {
  const u = { user_metadata: { password_set: true } };
  assert.equal(callbackDestination({ type: 'recovery', next: '/account/password', user: u }), '/account/password?mode=reset&next=%2Fdocuments');
  assert.equal(callbackDestination({ type: 'recovery', next: '/loads', user: u }), '/account/password?mode=reset&next=%2Floads');
});
test('callbackDestination: invite/magic link without password -> setup; with password -> next', () => {
  assert.equal(callbackDestination({ type: 'invite', next: '/loads', user: { user_metadata: {} } }), '/account/password?mode=setup&next=%2Floads');
  assert.equal(callbackDestination({ type: null, next: null, user: { user_metadata: {} } }), '/account/password?mode=setup&next=%2Fdocuments');
  assert.equal(callbackDestination({ type: 'magiclink', next: '/loads', user: { user_metadata: { password_set: true } } }), '/loads');
  assert.equal(callbackDestination({ type: null, next: '//evil.com', user: { user_metadata: { password_set: true } } }), '/documents');
});
test('recoveryRedirect and otpType', () => {
  assert.equal(recoveryRedirect('https://tms-app-two-pi.vercel.app'), 'https://tms-app-two-pi.vercel.app/auth/callback?type=recovery&next=%2Faccount%2Fpassword');
  assert.equal(otpType('recovery'), 'recovery');
  assert.equal(otpType('evil'), null);
});
test('pages wire the Supabase calls', () => {
  const pw = readFileSync('app/account/password/page.js', 'utf8');
  assert.match(pw, /updateUser\(\{ password: pw, data: \{ password_set: true \} \}\)/);
  assert.match(pw, /id="confirm-password"/);
  assert.match(pw, /autoComplete="new-password"/);
  const fp = readFileSync('app/forgot-password/page.js', 'utf8');
  assert.match(fp, /resetPasswordForEmail\(.*recoveryRedirect/);
  const login = readFileSync('app/login/page.js', 'utf8');
  assert.match(login, /Forgot password\?/);
  const cb = readFileSync('app/auth/callback/page.js', 'utf8');
  assert.match(cb, /verifyOtp\(\{ token_hash/);
  assert.match(cb, /callbackDestination/);
  assert.match(readFileSync('app/components/ui/AccountMenu.js', 'utf8'), /href="\/account\/password"/);
});
test('reset success: no redirect to forgot-password, no resend, Continue goes to next', () => {
  const pw = readFileSync('app/account/password/page.js', 'utf8');
  assert.doesNotMatch(pw, /resetPasswordForEmail|signOut|onAuthStateChange|router\.(push|replace)\(['"]\/forgot/);
  assert.match(pw, /Password saved\./);
  assert.match(pw, /window\.location\.replace\(next\)/);
  assert.match(pw, /history\.replaceState/);
  const fp = readFileSync('app/forgot-password/page.js', 'utf8');
  assert.match(fp, /ev\.persisted\) \{ setSent\(false\)/);
  assert.equal((fp.match(/resetPasswordForEmail/g) || []).length, 1);
  assert.match(fp, /onSubmit=\{onSubmit\}/);
});
test('sign out clears header user immediately', () => {
  const m = readFileSync('app/components/ui/AccountMenu.js', 'utf8');
  assert.match(m, /else \{ setUser\(null\); setOpen\(false\); router\.replace\('\/login'\)/);
});
