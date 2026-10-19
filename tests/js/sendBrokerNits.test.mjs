import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uniqueEmails, outsideRecipients, primaryButtonStyle } from '../../app/lib/packetSendClient.js';
import { blockedRecipients, validateSend } from '../../app/lib/packetSend.js';

test('uniqueEmails: case-insensitive, first-seen order and spelling', () => {
  assert.deepEqual(uniqueEmails(['B@x.com', 'a@y.com', 'b@X.com', '', 'A@Y.COM', 'c@z.com']), ['B@x.com', 'a@y.com', 'c@z.com']);
  assert.deepEqual(uniqueEmails(null), []);
});

test('outsideRecipients: broker-test@example.com in To and CC listed once', () => {
  const r = outsideRecipients('broker-test@example.com, ops@fstrucks.com', 'Broker-Test@Example.com; other@example.com', ['fstrucks.com']);
  assert.deepEqual(r, ['broker-test@example.com', 'other@example.com']);
  assert.deepEqual(outsideRecipients('a@example.com', '', null), []);
  assert.deepEqual(outsideRecipients('a@FSTRUCKS.com', '', ['fstrucks.com']), []);
});

test('server Not allowed message has no duplicates', () => {
  assert.deepEqual(blockedRecipients(['x@ex.com', 'X@EX.com', 'y@fstrucks.com'], ['fstrucks.com']), ['x@ex.com']);
  const r = validateSend({ to: 'broker-test@example.com', cc: 'BROKER-TEST@example.com', subject: 'T (FAKE)', body: 'B', confirm: true }, {});
  assert.equal(r.status, 403);
  assert.equal(r.error.match(/broker-test@example\.com/g).length, 1);
});

test('disabled Review email button looks disabled, enabled stays blue', () => {
  const base = { background: '#2563eb', color: '#fff' };
  const off = primaryButtonStyle(base, true);
  assert.notEqual(off.background, '#2563eb'); assert.equal(off.cursor, 'not-allowed'); assert.equal(off.background, 'var(--disabled-bg)'); assert.equal(off.color, 'var(--disabled-text)'); // QA #95: disabled tokens (>= 4.5:1) instead of fading
  const on = primaryButtonStyle(base, false);
  assert.equal(on.background, '#2563eb'); assert.equal(on.cursor, 'pointer'); assert.equal(on.opacity, undefined);
  const src = readFileSync(new URL('../../app/packets/PacketSendBroker.js', import.meta.url), 'utf8');
  assert.match(src, /primaryButtonStyle\(\{ \.\.\.primary, flex: 2 \}, outside\.length > 0\)\} disabled=\{outside\.length > 0\}/);
  assert.match(src, /outsideRecipients\(/);
});

import { actionBarShown, bottomReservePx, bottomPadding, COLLAPSED_RESERVE, BAR_MIN_RESERVE, sendWrapPadding } from '../../app/lib/packetLayout.js';

test('bottom space only reserved while the Fill & download bar is rendered (iPhone gap)', () => {
  assert.equal(actionBarShown({ canEdit: true, hideActionBar: false, dirty: false }), true);
  assert.equal(actionBarShown({ canEdit: true, hideActionBar: true, dirty: false }), false); // Review email open
  assert.equal(actionBarShown({ canEdit: true, hideActionBar: true, dirty: true }), true); // unsaved edits keep Save
  assert.equal(actionBarShown({ canEdit: false, hideActionBar: false, dirty: false }), false);
  assert.equal(bottomReservePx(true, 0), BAR_MIN_RESERVE);
  assert.equal(bottomReservePx(true, 180), 196);
  assert.equal(bottomReservePx(false, 180), COLLAPSED_RESERVE);
  assert.ok(COLLAPSED_RESERVE < 40);
  assert.equal(bottomPadding(16), 'calc(16px + var(--nav-h, 0px) + env(safe-area-inset-bottom))');
  const mapper = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
  assert.match(mapper, /paddingBottom: barShown \? bottomPadding\(bottomReservePx\(true, barH\)\) : COLLAPSED_RESERVE/);
  assert.match(mapper, /\{barShown && <div ref=\{bar\}/);
  assert.doesNotMatch(mapper, /Math\.max\(110, barH/);
  const page = readFileSync(new URL('../../app/packets/[id]/page.js', import.meta.url), 'utf8');
  assert.match(page, /onBarShownChange=\{setBarShown\}/);
  assert.match(page, /paddingBottom: sendWrapPadding\(barShown\)/);
  assert.doesNotMatch(page, /nav-h|safe-area|bottomPadding/); // body.has-appnav already reserves the nav + safe area
  assert.doesNotMatch(page, /0 0\.75rem 140px/);
});

test('send card wrapper: no double nav/safe-area reserve; bar space only while bar is shown (Taylor iPhone 14 Pro: 91px gap)', () => {
  assert.equal(sendWrapPadding(false), '0px');
  assert.equal(sendWrapPadding(true), '140px');
  assert.doesNotMatch(sendWrapPadding(false) + sendWrapPadding(true), /nav-h|safe-area/);
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /body\.has-appnav \{ padding-bottom: calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\)\); \}/); // nav + safe area live here
});
