import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteRewritePath, isSiteHost } from '../../app/lib/siteHost.js';

test('pwrstrong.net and www serve the site at /', () => {
  for (const h of ['pwrstrong.net', 'www.pwrstrong.net', 'WWW.PwrStrong.net', 'pwrstrong.net:443', 'pwrstrong.net.'])
    assert.equal(siteRewritePath(h, '/'), '/site', h);
});

test('other paths on the site host are untouched', () => {
  assert.equal(siteRewritePath('pwrstrong.net', '/privacy'), null);
  assert.equal(siteRewritePath('www.pwrstrong.net', '/login'), null);
});

test('app and preview hosts keep the app at /', () => {
  for (const h of ['tms-app-two-pi.vercel.app', 'tms-app-git-feat-x-fstrucks.vercel.app', 'localhost:3000', 'evilpwrstrong.net', 'pwrstrong.net.evil.com', '', null, undefined])
    assert.equal(siteRewritePath(h, '/'), null, String(h));
  assert.equal(isSiteHost('app.pwrstrong.net'), false);
});

test('Sign in goes to the app /login', async () => {
  const { signInHref } = await import('../../app/lib/siteHost.js');
  assert.equal(signInHref('https://tms-app-two-pi.vercel.app'), 'https://tms-app-two-pi.vercel.app/login');
  assert.equal(signInHref('https://tms-app-two-pi.vercel.app/'), 'https://tms-app-two-pi.vercel.app/login');
  assert.equal(signInHref(''), '/login');
});

import { isPublicPath, PUBLIC_PATHS } from '../../app/lib/legalRoutes.js';
import { isBugButtonHidden } from '../../app/lib/bugReport.js';
import { WELCOME_HIDDEN_PREFIXES } from '../../app/lib/welcome.js';
import { readFileSync as rf } from 'node:fs';
test('/site gets the signed-out treatment: no app nav, bug button, welcome sheet or deletion banner', () => {
  assert.ok(PUBLIC_PATHS.includes('/site'));
  assert.equal(isPublicPath('/site'), true);
  assert.equal(isPublicPath('/privacy'), true);
  assert.equal(isPublicPath('/sites'), false);
  assert.equal(isPublicPath('/loads'), false);
  assert.equal(isBugButtonHidden('/site'), true);
  assert.ok(WELCOME_HIDDEN_PREFIXES.includes('/site'));
  assert.match(rf(new URL('../../app/components/AppNav.js', import.meta.url), 'utf8'), /const HIDDEN = \(p\) => p\.startsWith\('\/login'\) \|\| isPublicPath\(p\);/);
  assert.match(rf(new URL('../../app/components/DeletionBanner.js', import.meta.url), 'utf8'), /isPublicPath\(pathname\)/);
});
test('site page: company and domain facts', () => {
  const p = rf(new URL('../../app/site/page.js', import.meta.url), 'utf8');
  assert.match(p, /Power Strong Solutions LLC/);
  assert.match(p, /https:\/\/pwrstrong\.net\//);
  assert.equal(/\b(AI|bots?|Grok)\b/.test(p), false);
});
