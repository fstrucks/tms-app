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
