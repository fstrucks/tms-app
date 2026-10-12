import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { movePage, removePage, replacePage, fitWidth, fitLongSide, pdfPageSize, warpSize, orderCorners, homography, applyH,
  detectQuad, plausibleQuad, planSave, fitLongSide as fls, SOURCE_MAX, capPages, MAX_PAGES, levelsLut, buildPdf, scanFileName, PAGE_MAX_WIDTH } from '../../app/lib/scan.js';

const JPG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAWABEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2aiiigAooooAKKKKACiiigD//2Q==', 'base64')); // 17x22 white JPEG

test('movePage: forward, backward, clamped, no-op, immutable', () => {
  const p = ['a', 'b', 'c', 'd'];
  assert.deepEqual(movePage(p, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(movePage(p, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(movePage(p, 1, 99), ['a', 'c', 'd', 'b']);
  assert.deepEqual(movePage(p, 2, 2), p);
  assert.deepEqual(movePage(p, 9, 0), p);
  assert.deepEqual(p, ['a', 'b', 'c', 'd']);
});
test('removePage / replacePage', () => {
  assert.deepEqual(removePage(['a', 'b', 'c'], 1), ['a', 'c']);
  assert.deepEqual(removePage(['a'], 0), []);
  assert.deepEqual(replacePage(['a', 'b'], 1, 'x'), ['a', 'x']);
});
test('fitWidth caps at 1700 and never upscales', () => {
  assert.deepEqual(fitWidth(3400, 4400), { width: 1700, height: 2200 });
  assert.deepEqual(fitWidth(1200, 1600), { width: 1200, height: 1600 });
  assert.equal(fitWidth(4032, 3024).width, PAGE_MAX_WIDTH);
  assert.throws(() => fitWidth(0, 10));
  assert.deepEqual(fitLongSide(4000, 3000, 2000), { width: 2000, height: 1500 });
});
test('pdfPageSize: letter width, aspect kept', () => {
  assert.deepEqual(pdfPageSize(1700, 2200), { width: 612, height: 792 });
  assert.equal(pdfPageSize(1700, 1700).height, 612);
});
test('warpSize from quad, capped', () => {
  const q = [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2600 }, { x: 0, y: 2600 }];
  assert.deepEqual(warpSize(q), { width: 1700, height: 2210 });
});
test('orderCorners', () => {
  const o = orderCorners([{ x: 90, y: 95 }, { x: 10, y: 5 }, { x: 5, y: 90 }, { x: 95, y: 10 }]);
  assert.deepEqual(o, [{ x: 10, y: 5 }, { x: 95, y: 10 }, { x: 90, y: 95 }, { x: 5, y: 90 }]);
});
test('homography maps the 4 corners exactly', () => {
  const src = [{ x: 12, y: 30 }, { x: 410, y: 8 }, { x: 450, y: 590 }, { x: 0, y: 560 }];
  const dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 130 }, { x: 0, y: 130 }];
  const H = homography(src, dst);
  src.forEach((p, i) => { const r = applyH(H, p.x, p.y); assert.ok(Math.abs(r.x - dst[i].x) < 1e-6 && Math.abs(r.y - dst[i].y) < 1e-6); });
});
test('detectQuad finds a bright tilted page on a dark background; null when no background', () => {
  const w = 200, h = 200, g = new Uint8Array(w * h).fill(40);
  const quad = [{ x: 50, y: 30 }, { x: 160, y: 50 }, { x: 150, y: 175 }, { x: 35, y: 160 }];
  const inside = (x, y) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = quad[i], b = quad[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) g[y * w + x] = 230;
  const q = detectQuad(g, w, h);
  assert.ok(q);
  q.forEach((p, i) => assert.ok(Math.hypot(p.x - quad[i].x, p.y - quad[i].y) < 4, JSON.stringify([p, quad[i]])));
  assert.equal(detectQuad(new Uint8Array(w * h).fill(230), w, h), null);
  assert.equal(detectQuad(new Uint8Array(w * h).fill(40), w, h), null);
});
test('levelsLut: monotonic; bw pushes paper to white and ink to black', () => {
  const g = new Uint8Array(1000); for (let i = 0; i < 1000; i++) g[i] = i < 100 ? 60 : 200;
  const lut = levelsLut(g, 'bw');
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1]);
  assert.equal(lut[200], 255); assert.equal(lut[60], 0);
});
test('buildPdf: one page per image, letter width, order kept', async () => {
  const pages = [{ bytes: JPG, width: 1700, height: 2200 }, { bytes: JPG, width: 1700, height: 1100 }];
  const bytes = await buildPdf(pages, PDFDocument);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 612, height: 792 });
  assert.deepEqual(doc.getPage(1).getSize(), { width: 612, height: 396 });
  await assert.rejects(() => buildPdf([], PDFDocument));
});
test('scanFileName', () => {
  assert.equal(scanFileName('bol', new Date(2026, 9, 12, 8, 5)), 'BOL_2026-10-12_0805.pdf');
});

test('plausibleQuad rejects near-full-frame, edge-touching, odd angles, extreme aspect', () => {
  const W = 1000, H = 1000;
  const good = [{ x: 100, y: 80 }, { x: 850, y: 120 }, { x: 820, y: 900 }, { x: 120, y: 880 }];
  assert.equal(plausibleQuad(good, W, H), true);
  assert.equal(plausibleQuad([{ x: 20, y: 20 }, { x: 980, y: 20 }, { x: 980, y: 980 }, { x: 20, y: 980 }], W, H), false); // ~92%+
  assert.equal(plausibleQuad([{ x: 0, y: 80 }, { x: 850, y: 120 }, { x: 820, y: 900 }, { x: 120, y: 880 }], W, H), false); // touches edge
  assert.equal(plausibleQuad([{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 600, y: 500 }, { x: 400, y: 500 }], W, H), false); // odd angles
  assert.equal(plausibleQuad([{ x: 100, y: 450 }, { x: 900, y: 450 }, { x: 900, y: 540 }, { x: 100, y: 540 }], W, H), false); // aspect ~9
  assert.equal(plausibleQuad(null, W, H), false);
});
test('detectQuad: page that fills the frame or touches the border is "not detected"', () => {
  const w = 200, h = 200, g = new Uint8Array(w * h).fill(40);
  for (let y = 0; y < h; y++) for (let x = 0; x < 150; x++) g[y * w + x] = 230; // bright region runs off top/bottom/left
  assert.equal(detectQuad(g, w, h), null);
  const g2 = new Uint8Array(w * h).fill(40);
  for (let y = 3; y < 197; y++) for (let x = 3; x < 197; x++) g2[y * w + x] = 230; // ~94% of frame
  assert.equal(detectQuad(g2, w, h), null);
});
test('capPages: 20-page cap', () => {
  assert.equal(MAX_PAGES, 20);
  assert.deepEqual(capPages(18, ['a', 'b', 'c']), { accepted: ['a', 'b'], rejected: 1 });
  assert.deepEqual(capPages(20, ['a']), { accepted: [], rejected: 1 });
  assert.deepEqual(capPages(0, ['a', 'b']), { accepted: ['a', 'b'], rejected: 0 });
  assert.deepEqual(capPages(25, []), { accepted: [], rejected: 0 });
});

test('12 MP photo -> page at least 1275px wide (crop from the original, not the 1700px preview)', () => {
  // Portrait 3000x4000, page filling ~70% of the width, picked on the preview.
  let pv = fls(3000, 4000, SOURCE_MAX);
  let q = [{ x: 0.15, y: 0.1 }, { x: 0.85, y: 0.12 }, { x: 0.83, y: 0.9 }, { x: 0.17, y: 0.88 }].map((p) => ({ x: p.x * pv.width, y: p.y * pv.height }));
  let plan = planSave(3000, 4000, pv.width, pv.height, q);
  assert.deepEqual(plan.source, { width: 2250, height: 3000 });
  assert.ok(plan.out.width >= 1275 && plan.out.width <= 1700, JSON.stringify(plan.out));
  // Landscape 4000x3000 with a portrait page across ~85% of the height.
  pv = fls(4000, 3000, SOURCE_MAX);
  q = [{ x: 0.25, y: 0.07 }, { x: 0.75, y: 0.07 }, { x: 0.75, y: 0.93 }, { x: 0.25, y: 0.93 }].map((p) => ({ x: p.x * pv.width, y: p.y * pv.height }));
  plan = planSave(4000, 3000, pv.width, pv.height, q);
  assert.ok(plan.out.width >= 1275, JSON.stringify(plan.out));
  // Full-frame portrait 12 MP: capped at 1700 wide.
  pv = fls(3000, 4000, SOURCE_MAX);
  plan = planSave(3000, 4000, pv.width, pv.height, [{ x: 0, y: 0 }, { x: pv.width, y: 0 }, { x: pv.width, y: pv.height }, { x: 0, y: pv.height }]);
  assert.deepEqual(plan.out, { width: 1700, height: 2267 });
});

// ---- size fallback ----
import { buildPdfWithinLimit, SIZE_STEPS, PDF_MAX_BYTES, decodeResize, JPEG_QUALITY, SAVE_SOURCE_MAX } from '../../app/lib/scan.js';
const fakeSize = (sizeFor) => ({ render: async (s) => [s], build: async ([s]) => new Uint8Array(sizeFor(s)) });

test('SIZE_STEPS: normal, q0.55, q0.45, then 1400px', () => {
  assert.deepEqual(SIZE_STEPS.map((s) => [s.quality, s.maxW]), [[JPEG_QUALITY, PAGE_MAX_WIDTH], [0.55, 1700], [0.45, 1700], [0.45, 1400]]);
  assert.equal(PDF_MAX_BYTES, 10 * 1024 * 1024);
});
test('buildPdfWithinLimit: under the limit builds once, no compressing', async () => {
  const seen = []; const f = fakeSize(() => 100);
  const r = await buildPdfWithinLimit(f.render, f.build, { maxBytes: 1000, onStep: (i) => seen.push(i) });
  assert.equal(r.ok, true); assert.equal(r.attempts, 1); assert.deepEqual(seen, [0]); assert.equal(r.step, SIZE_STEPS[0]);
});
test('buildPdfWithinLimit: slightly over jumps straight to q0.55', async () => {
  const f = fakeSize((s) => (s.quality > 0.6 ? 1100 : 900));
  const r = await buildPdfWithinLimit(f.render, f.build, { maxBytes: 1000 });
  assert.equal(r.ok, true); assert.equal(r.step.quality, 0.55); assert.deepEqual(r.sizes, [1100, 900]);
});
test('buildPdfWithinLimit: estimate skips steps (1.3x over -> q0.45 directly)', async () => {
  const seen = []; const f = fakeSize((s) => Math.round(1300 * s.factor));
  const r = await buildPdfWithinLimit(f.render, f.build, { maxBytes: 1000, onStep: (i) => seen.push(i) });
  assert.equal(r.ok, true); assert.deepEqual(seen, [0, 2]); assert.equal(r.attempts, 2);
});
test('buildPdfWithinLimit: reaches 1400px step', async () => {
  const seen = []; const f = fakeSize((s) => (s.maxW === 1400 ? 999 : 1500));
  const r = await buildPdfWithinLimit(f.render, f.build, { maxBytes: 1000, onStep: (i, s) => seen.push([i, s.maxW]) });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.equal(r.step.maxW, 1400);
  assert.deepEqual(seen.map((x) => x[0]), [0, 3]);
});
test('buildPdfWithinLimit: nothing fits -> ok false, smallest attempt returned', async () => {
  const f = fakeSize((s) => Math.round(s.quality * 10000 + s.maxW));
  const r = await buildPdfWithinLimit(f.render, f.build, { maxBytes: 10 });
  assert.equal(r.ok, false); assert.equal(r.attempts, 2); assert.equal(r.bytes.length, Math.min(...r.sizes)); assert.equal(r.step.maxW, 1400);
});
test('buildPdfWithinLimit: exactly at the limit counts as fitting', async () => {
  const f = fakeSize(() => 1000);
  assert.equal((await buildPdfWithinLimit(f.render, f.build, { maxBytes: 1000 })).ok, true);
});
test('buildPdfWithinLimit: with real pdf-lib, smaller JPEGs make it fit', async () => {
  const big = new Uint8Array(JPG.length + 4000); big.set(JPG.subarray(0, JPG.length - 2)); big.set([0xff, 0xd9], big.length - 2);
  const r = await buildPdfWithinLimit(async (s) => [{ bytes: s.quality > 0.5 ? big : JPG, width: 17, height: 22 }], (p) => buildPdf(p, PDFDocument), { maxBytes: 3000 });
  assert.equal(r.ok, true); assert.equal(r.step.quality, 0.45);
  assert.equal((await PDFDocument.load(r.bytes)).getPageCount(), 1);
});
test('decodeResize: axis from the real size, no resize <= 3000, unknown -> null', () => {
  assert.deepEqual(decodeResize(8064, 6048), { resizeWidth: SAVE_SOURCE_MAX, resizeQuality: 'high' });
  assert.deepEqual(decodeResize(6000, 8000), { resizeHeight: 3000, resizeQuality: 'high' });
  assert.deepEqual(decodeResize(3024, 4032), { resizeHeight: 3000, resizeQuality: 'high' });
  assert.deepEqual(decodeResize(4000, 4000), { resizeWidth: 3000, resizeQuality: 'high' });
  assert.equal(decodeResize(2000, 1500), null);
  assert.equal(decodeResize(3000, 2000), null);
  assert.equal(decodeResize(null, null), null);
});
test('buildPdfWithinLimit: onProgress per page with the step index', async () => {
  const calls = [];
  const r = await buildPdfWithinLimit(async (s, progress) => { for (let x = 1; x <= 3; x++) progress(x, 3); return [s]; },
    async ([s]) => new Uint8Array(s.quality > 0.6 ? 1100 : 900), { maxBytes: 1000, onProgress: (k, x, n) => calls.push(`${k}:${x}/${n}`) });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['0:1/3', '0:2/3', '0:3/3', '1:1/3', '1:2/3', '1:3/3']);
});

import { probeImageSize, nextSizeStep } from '../../app/lib/scan.js';
test('probeImageSize: JPEG SOF', () => { assert.deepEqual(probeImageSize(JPG), { width: 17, height: 22 }); });
test('probeImageSize: JPEG EXIF orientation 6 swaps', () => {
  const tiff = [0x4d,0x4d,0,0x2a,0,0,0,8, 0,1, 0x01,0x12,0,3,0,0,0,1,0,6,0,0, 0,0,0,0];
  const app1 = [0xff,0xe1,0,2+6+tiff.length, 0x45,0x78,0x69,0x66,0,0, ...tiff];
  const b = new Uint8Array([0xff,0xd8, ...app1, ...JPG.subarray(2)]);
  assert.deepEqual(probeImageSize(b), { width: 22, height: 17 });
});
test('probeImageSize: PNG', () => {
  const b = new Uint8Array(32); b.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52, 0,0,0x17,0x70, 0,0,0x1f,0x40]);
  assert.deepEqual(probeImageSize(b), { width: 6000, height: 8000 });
});
test('probeImageSize: HEIC largest ispe + irot', () => {
  const box = (w, h) => [0,0,0,20, 0x69,0x73,0x70,0x65, 0,0,0,0, (w>>>24)&255,(w>>>16)&255,(w>>>8)&255,w&255, (h>>>24)&255,(h>>>16)&255,(h>>>8)&255,h&255];
  const head = [0,0,0,24, 0x66,0x74,0x79,0x70, 0x68,0x65,0x69,0x63];
  const b1 = new Uint8Array([...head, ...box(512, 512), ...box(8064, 6048), 0,0,0,0,0,0,0,0]);
  assert.deepEqual(probeImageSize(b1), { width: 8064, height: 6048 });
  const b2 = new Uint8Array([...head, ...box(8064, 6048), 0,0,0,9, 0x69,0x72,0x6f,0x74, 1, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
  assert.deepEqual(probeImageSize(b2), { width: 6048, height: 8064 });
  assert.equal(probeImageSize(new Uint8Array(40)), null);
});
test('nextSizeStep: picks the first step estimated to fit, else the last, -1 when done', () => {
  assert.equal(nextSizeStep(1050, 0, { maxBytes: 1000 }), 1);
  assert.equal(nextSizeStep(1300, 0, { maxBytes: 1000 }), 2);
  assert.equal(nextSizeStep(5000, 0, { maxBytes: 1000 }), 3);
  assert.equal(nextSizeStep(5000, 3, { maxBytes: 1000 }), -1);
});
