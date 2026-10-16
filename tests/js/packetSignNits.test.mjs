import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fieldState, summarize } from '../../app/lib/packetMapperModel.js';
import { pxPerCss, parseInch } from '../../app/lib/packetDrag.js';
import { loginHref, safeNext } from '../../app/lib/safeNext.js';
import { callbackDestination } from '../../app/lib/passwordSetup.js';
const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('drag/tap convert pointer deltas with the rendered page rect (getBoundingClientRect), not layout width', () => {
  const m = src('app/packets/PacketMapper.js');
  assert.match(src('app/lib/packetDrag.js'), /export function pxPerCss\(el, img\)[\s\S]*getBoundingClientRect/);
  assert.match(m, /k: pxPerCss\(wrap\.current, img\)/);
  assert.match(m, /dragBox\(c\.box, c\.mode, c\.dx \* c\.k, c\.dy \* c\.k/);
  assert.doesNotMatch(m, /c\.dx \/ scale|d\.dx \/ scale/);
  // the box's own style must not clip the 44px resize target
  const boxStyle = m.slice(m.indexOf("overflow: 'visible', position: 'absolute'"), m.indexOf("whiteSpace: 'nowrap' }}>"));
  assert.doesNotMatch(boxStyle, /overflow: 'hidden'/);
});
test('pxPerCss: rendered 390 css px for a 1700 px page → 4.36 page px per css px (DPR-independent)', async () => {
  const f = pxPerCss;
  assert.equal(Math.round(f({ getBoundingClientRect: () => ({ width: 390 }) }, { w: 1700 }) * 100) / 100, 4.36);
  assert.equal(f(null, { w: 1700 }), 1);
});
test('inch box: empty allowed while typing; only valid numbers apply', () => {
  const m = src('app/packets/PacketMapper.js');
  assert.match(m, /function InchInput/); assert.match(m, /onBlur=/);
  const parse = parseInch;
  for (const [v, want] of [['', null], ['.', null], ['0', null], ['1.', 1], ['.5', 0.5], ['2.25', 2.25], ['abc', null], ['99', null]]) assert.equal(parse(v), want, v);
});
test('signature rows: unsigned shows "Needs signature" (incl. after clear); signed is OK', () => {
  assert.equal(fieldState({ kind: 'signature', profile_key: 'signature', signed: false }), 'sign');
  assert.equal(fieldState({ kind: 'signature', profile_key: 'signature', signed: true }), 'ok');
  assert.equal(summarize([{ kind: 'signature', profile_key: 'signature' }]).sign, 1);
  assert.match(src('app/packets/PacketMapper.js'), /sign: 'Needs signature'/);
});
test('pad: "Sign the signature field." opens the pad; Done/Cancel close the edit panel', () => {
  const m = src('app/packets/PacketMapper.js');
  assert.match(m, /if \(w\.code === 'unsigned'\) \{ setSel\(null\); startSign\(w\.field\); \}/);
  assert.match(m, /setSigning\(null\); setSel\(null\); setBusy\(true\)/);
  assert.match(m, /onCancel=\{\(\) => \{ setSigning\(null\); setSel\(null\); \}\}/);
});
test('sign-in returns to the packet: header link + sign-out carry a safe same-origin next', () => {
  assert.equal(loginHref('/packets/abc?x=1'), '/login?next=%2Fpackets%2Fabc%3Fx%3D1');
  assert.equal(safeNext(decodeURIComponent('%2Fpackets%2Fabc')), '/packets/abc');
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/login']) assert.equal(safeNext(bad), '/documents', bad);
  assert.equal(callbackDestination({ type: 'magiclink', next: '/packets/abc', user: { user_metadata: { password_set: true } } }), '/packets/abc');
  const a = src('app/components/ui/AccountMenu.js');
  assert.match(a, /loginHref\(window\.location\.pathname \+ window\.location\.search\)/);
  assert.match(a, /<Link href=\{loginHrefState\}/);
  const login = src('app/login/page.js');
  assert.match(login, /window\.location\.assign\(safeNext\(nextParam\(\)\)\)/);
  assert.match(login, /auth\/callback\?next=' \+ encodeURIComponent\(safeNext\(nextParam\(\)\)\)/);
});
