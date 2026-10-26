// Scanned images came out solid black (Taylor's QA of #153): transparent pixels were encoded to JPEG as black.
// Fake images only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { flattenOnWhite } from '../../app/lib/scan.js';
import { buildBundlePdf, isPngBytes } from '../../app/lib/invoiceBundlePdf.js';

// Minimal RGBA PNG: w x h, every pixel (r,g,b,a).
function png(w, h, px) {
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px, y * (w * 4 + 1) + 1 + x * 4);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('flattenOnWhite: transparent (0,0,0,0) → white; opaque unchanged; half alpha blends', () => {
  const d = new Uint8ClampedArray([0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 128]);
  flattenOnWhite(d);
  assert.deepEqual([...d.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...d.slice(4, 8)], [10, 20, 30, 255]);
  assert.equal(d[11], 255); assert.ok(d[8] > 120 && d[8] < 135);
});

test('scanner paints white under every drawImage before JPEG encoding', () => {
  const src = readFileSync(new URL('../../app/components/scanner/imaging.js', import.meta.url), 'utf8');
  assert.match(src, /function drawOnWhite\(ctx, src, w, h\) \{ ctx\.fillStyle = 'white'; ctx\.fillRect\(0, 0, w, h\); ctx\.drawImage/);
  const bare = src.split('\n').filter((l) => /\.drawImage\(/.test(l) && !/function drawOnWhite/.test(l));
  assert.deepEqual(bare, [], 'every canvas draw in imaging.js goes through drawOnWhite');
  assert.match(src, /flattenOnWhite\(sctx\.getImageData/);
});

test('export: a transparent PNG and a JPEG-in-.png file both land on a white page (not skipped)', async () => {
  const clear = png(4, 4, [0, 0, 0, 0]);
  assert.equal(isPngBytes(clear), true);
  // a JPEG named .png: decoder chosen by bytes
  const jpeg = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
  const files = { 'o/a.png': clear, 'o/b.png': jpeg };
  const r = await buildBundlePdf(null, [
    { name: 'clear', doc: { file_path: 'o/a.png' }, supported: true },
    { name: 'jpeg', doc: { file_path: 'o/b.png' }, supported: true },
  ], async (p) => files[p]);
  assert.deepEqual(r.skipped, []);
  const pdf = await PDFDocument.load(r.bytes);
  assert.equal(pdf.getPageCount(), 2);
  const lib = readFileSync(new URL('../../app/lib/invoiceBundlePdf.js', import.meta.url), 'utf8');
  assert.match(lib, /drawRectangle\(\{ x: 0, y: 0, width: 612, height: 792, color: rgb\(1, 1, 1\) \}\)/, 'white paper under the image');
});
