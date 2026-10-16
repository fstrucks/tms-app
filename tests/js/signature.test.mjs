import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findInkBounds, buildSignaturePayload, cleanSignerName, isValidSignerName, canFinish, midpoint, SIGNER_NAME_MAX } from '../../app/lib/signature.js';

const rgba = (w, h, inked = []) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, a = 255] of inked) d[(y * w + x) * 4 + 3] = a;
  return d;
};
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('findInkBounds: empty canvas -> null', () => {
  assert.equal(findInkBounds(rgba(10, 10), 10, 10), null);
  assert.equal(findInkBounds(null, 10, 10), null);
  assert.equal(findInkBounds(rgba(2, 2), 10, 10), null);
});

test('findInkBounds: exact box with no padding', () => {
  assert.deepEqual(findInkBounds(rgba(20, 10, [[3, 2], [7, 5], [5, 8]]), 20, 10, 0), { x: 3, y: 2, w: 5, h: 7 });
});

test('findInkBounds: padding applied and clamped to edges', () => {
  assert.deepEqual(findInkBounds(rgba(20, 20, [[10, 10]]), 20, 20, 3), { x: 7, y: 7, w: 7, h: 7 });
  assert.deepEqual(findInkBounds(rgba(10, 10, [[0, 0], [9, 9]]), 10, 10, 5), { x: 0, y: 0, w: 10, h: 10 });
});

test('findInkBounds: alpha threshold ignores faint pixels', () => {
  const d = rgba(10, 10, [[1, 1, 5], [4, 4, 200]]);
  assert.deepEqual(findInkBounds(d, 10, 10, 0, 10), { x: 4, y: 4, w: 1, h: 1 });
  assert.deepEqual(findInkBounds(d, 10, 10, 0), { x: 1, y: 1, w: 4, h: 4 });
});

test('signer name validation', () => {
  assert.equal(cleanSignerName('  Marc   Brooks '), 'Marc Brooks');
  for (const bad of ['', '   ', null, undefined, 42, '123', 'x'.repeat(SIGNER_NAME_MAX + 1)]) assert.equal(isValidSignerName(bad), false, String(bad));
  assert.equal(isValidSignerName('José Núñez'), true);
});

test('buildSignaturePayload shape', () => {
  const now = new Date('2026-10-15T22:00:00-07:00');
  assert.deepEqual(buildSignaturePayload({ dataUrl: PNG, signerName: ' Marc Brooks ', method: 'draw', now }),
    { dataUrl: PNG, signerName: 'Marc Brooks', signedAt: '2026-10-16T05:00:00.000Z', method: 'draw' });
  const p = buildSignaturePayload({ dataUrl: PNG, signerName: 'Marc', method: 'type' });
  assert.deepEqual(Object.keys(p).sort(), ['dataUrl', 'method', 'signedAt', 'signerName']);
  assert.ok(!Number.isNaN(Date.parse(p.signedAt)));
});

test('buildSignaturePayload rejects bad input', () => {
  assert.equal(buildSignaturePayload({ dataUrl: PNG, signerName: '', method: 'draw' }), null);
  assert.equal(buildSignaturePayload({ dataUrl: 'data:image/jpeg;base64,xx', signerName: 'M', method: 'draw' }), null);
  assert.equal(buildSignaturePayload({ dataUrl: PNG, signerName: 'M', method: 'stamp' }), null);
  assert.equal(buildSignaturePayload({ dataUrl: PNG, signerName: 'M', method: 'draw', now: 'nope' }), null);
});

test('canFinish gating', () => {
  assert.equal(canFinish({ signerName: '', method: 'draw', hasInk: true }), false);
  assert.equal(canFinish({ signerName: 'Marc', method: 'draw', hasInk: false }), false);
  assert.equal(canFinish({ signerName: 'Marc', method: 'draw', hasInk: true }), true);
  assert.equal(canFinish({ signerName: 'Marc', method: 'type' }), true);
  assert.equal(canFinish({ signerName: 'Marc', method: 'other', hasInk: true }), false);
});

test('midpoint', () => { assert.deepEqual(midpoint({ x: 0, y: 0 }, { x: 4, y: 10 }), { x: 2, y: 5 }); });

test('SignaturePad component: client, pointer events, touch-action none, 44px targets, not wired in', () => {
  const src = readFileSync(new URL('../../app/components/SignaturePad.js', import.meta.url), 'utf8');
  assert.match(src, /^'use client';/);
  for (const s of ['onPointerDown', 'touchAction: \'none\'', 'devicePixelRatio', 'minHeight: 44', 'cursive', 'onCancel']) assert.ok(src.includes(s), s);
  for (const f of ['../../app/packets/page.js', '../../app/packets/[id]/page.js', '../../app/packets/PacketMapper.js']) {
    assert.ok(!readFileSync(new URL(f, import.meta.url), 'utf8').includes('SignaturePad'), f);
  }
});

test('/dev/signature QA route exists and is gated off in production', () => {
  const page = readFileSync(new URL('../../app/dev/signature/page.js', import.meta.url), 'utf8');
  assert.match(page, /process\.env\.VERCEL_ENV === 'production'/);
  assert.match(page, /notFound\(\)/);
  assert.doesNotMatch(page, /^'use client'/);
  const qa = readFileSync(new URL('../../app/dev/signature/SignatureQA.js', import.meta.url), 'utf8');
  for (const s of ['SignaturePad', 'onCancel', 'Cancelled', 'signedAt', '<img']) assert.ok(qa.includes(s), s);
});

test('script font is self-hosted Dancing Script (OFL) with no external font URL', () => {
  const dir = new URL('../../app/fonts/dancing-script/', import.meta.url);
  const woff2 = readFileSync(new URL('DancingScript-Variable.woff2', dir));
  assert.equal(woff2.subarray(0, 4).toString('latin1'), 'wOF2');
  assert.ok(woff2.length > 10000);
  const ofl = readFileSync(new URL('OFL.txt', dir), 'utf8');
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.match(ofl, /Dancing Script/);
  const src = readFileSync(new URL('../../app/components/SignaturePad.js', import.meta.url), 'utf8');
  assert.match(src, /from 'next\/font\/local'/);
  assert.ok(src.includes('DancingScript-Variable.woff2'));
  assert.ok(src.includes('cursive'));
  assert.match(src, /document\.fonts\??\.load\(/);
  assert.doesNotMatch(src, /fonts\.googleapis|fonts\.gstatic|next\/font\/google|https?:\/\//);
});

test('Taylor nits: willReadFrequently and resize notice only after drawing', () => {
  const src = readFileSync(new URL('../../app/components/SignaturePad.js', import.meta.url), 'utf8');
  assert.ok(src.includes("getContext('2d', { willReadFrequently: true })"));
  assert.ok(!/getContext\('2d'\)\s*[;.]/.test(src.replace(/out\.getContext\('2d'\)/g, '')));
  assert.match(src, /if \(resized && drawnRef\.current\) setNotice\('Pad resized/);
});
