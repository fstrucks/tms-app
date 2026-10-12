import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { movePage, removePage, replacePage, fitWidth, fitLongSide, pdfPageSize, warpSize, orderCorners, homography, applyH,
  detectQuad, levelsLut, buildPdf, scanFileName, PAGE_MAX_WIDTH } from '../../app/lib/scan.js';

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
