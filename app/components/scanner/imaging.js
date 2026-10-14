'use client';
// Browser-only image steps for the scanner (canvas). Pure math lives in app/lib/scan.js.
// Memory: each page keeps only a JPEG Blob (long side <= SOURCE_MAX) plus a small thumbnail URL.
// Canvases/bitmaps are created per operation and released right after (width/height = 0, close()).
import { fitLongSide, detectQuad, fullFrame, homography, warpSize, levelsLut, planSave, decodeResize, decodeGuarded, TOO_LARGE, heicFallbackAllowed, probeImageSize, SAVE_SOURCE_MAX, JPEG_QUALITY, SOURCE_MAX, THUMB_W } from '../../lib/scan';

const DETECT_MAX = 400; // edge detection runs on a small copy

function isHeic(file) {
  const t = (file.type || '').toLowerCase();
  return t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(file.name || '');
}

export function rejectReason(file) {
  const t = (file.type || '').toLowerCase();
  if (t.includes('svg') || /\.svg$/i.test(file.name || '')) return 'SVG images are not supported.';
  if (t && !t.startsWith('image/')) return 'Pick a photo (JPEG, PNG, WebP or HEIC).';
  if (!file.size) return 'The photo is empty.';
  return null;
}

export function release(...items) {
  for (const it of items) {
    if (!it) continue;
    if (typeof it.close === 'function') { try { it.close(); } catch {} } // ImageBitmap
    else if ('width' in it && 'height' in it && it.getContext) { it.width = 0; it.height = 0; } // canvas
  }
}
export function revoke(url) { if (url) URL.revokeObjectURL(url); }

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// Real (oriented) size from the file header, without decoding. null if unknown.
export async function probeSize(blob) {
  try { return probeImageSize(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer())); } catch { return null; }
}

// Decode to a bitmap with the long edge <= SAVE_SOURCE_MAX, never building a full-size canvas
// (iOS caps canvases at ~16.7 MP). The resize axis comes from the real size (header probe);
// images with long edge <= 3000 are decoded as-is. If the size is unknown, decode width-first,
// then redo by height if the result shows a portrait.
export async function decodeBitmap(blob, size) {
  return decodeGuarded(blob, size, {
    cib: (bl, o) => createImageBitmap(bl, o),
    close: (bm) => release(bm),
    drawDown: async (bmp, w, h) => { // target canvas is <= 3000x3000 (9 MP)
      const c = canvas(w, h);
      try { c.getContext('2d').drawImage(bmp, 0, 0, w, h); return await createImageBitmap(c); } finally { release(c); }
    },
  });
}

// Native decode first (Safari reads HEIC itself); heic2any only if that fails. Returns
// { src (Blob kept for save: the file itself, not a copy), size (real size of src), bmp (<= 3000px) }.
async function openPhoto(file) {
  const size = await probeSize(file);
  try { const bmp = await decodeBitmap(file, size); return { src: file, size: size || { width: bmp.width, height: bmp.height }, bmp }; }
  catch (e) {
    if (e && e.message === TOO_LARGE) throw e; // never fall back to a full-size decode
    if (!isHeic(file)) {
      const img = await decodeFile(file); // old browsers without resize options
      try { const bmp = await createImageBitmap(img); return { src: file, size: { width: bmp.width, height: bmp.height }, bmp }; } finally { img.src = ''; }
    }
  }
  // heic2any draws a full-size canvas: refuse anything over the iOS canvas limit up front.
  if (!heicFallbackAllowed(size)) throw new Error(TOO_LARGE);
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const jpg = Array.isArray(out) ? out[0] : out;
  const jsize = await probeSize(jpg);
  const bmp = await decodeBitmap(jpg, jsize);
  return { src: jpg, size: jsize || { width: bmp.width, height: bmp.height }, bmp };
}

async function decodeFile(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode(); // EXIF orientation is applied by the browser when drawing
    return img;
  } finally { revoke(url); }
}

export function toBlob(c, type = 'image/jpeg', q = JPEG_QUALITY) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));
}

function toGray(data, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}

function detectOn(drawable, w, h) {
  const { width: dw, height: dh } = fitLongSide(w, h, DETECT_MAX);
  const c = canvas(dw, dh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(drawable, 0, 0, dw, dh);
  let q = null;
  try { q = detectQuad(toGray(ctx.getImageData(0, 0, dw, dh).data, dw * dh), dw, dh); } catch { q = null; }
  release(c);
  if (!q) return { quad: fullFrame(w, h), detected: false };
  const kx = w / dw, ky = h / dh;
  return { quad: q.map((p) => ({ x: p.x * kx, y: p.y * ky })), detected: true };
}

// File -> { orig (the original Blob, kept as-is: no re-encode), ow, oh (its real size), blob (preview JPEG,
// long side <= SOURCE_MAX), w, h, quad (preview px), detected }. Save re-decodes orig straight to <= 3000px.
export async function loadPhoto(file) {
  const { src, size, bmp } = await openPhoto(file);
  const { width: w, height: h } = fitLongSide(bmp.width, bmp.height, SOURCE_MAX);
  const c = canvas(w, h);
  try {
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    release(bmp);
    const det = detectOn(c, w, h);
    const blob = await toBlob(c, 'image/jpeg', 0.9);
    return { orig: src, ow: size.width, oh: size.height, blob, w, h, ...det };
  } finally { release(bmp, c); }
}

export async function bitmapOf(blob, opts) { return createImageBitmap(blob, opts); }

export async function redetect(page) {
  const bmp = await bitmapOf(page.blob);
  try { return detectOn(bmp, page.w, page.h); } finally { release(bmp); }
}

// Perspective crop (bilinear) + cleanup from a drawable of size (sw, sh). quad in that drawable's px.
function warp(drawable, sw, sh, quad, mode, maxW) {
  const sc = canvas(sw, sh);
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(drawable, 0, 0, sw, sh);
  const src = sctx.getImageData(0, 0, sw, sh).data;
  release(sc);
  const { width: W, height: H } = warpSize(quad, maxW);
  const out = canvas(W, H);
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H), d = img.data;
  const M = homography(fullFrame(W, H), quad); // output px -> source px
  const maxX = sw - 1, maxY = sh - 1;
  for (let y = 0; y < H; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < W; x++) {
      const xx = x + 0.5, wz = M[6] * xx + M[7] * yy + M[8];
      let fx = (M[0] * xx + M[1] * yy + M[2]) / wz - 0.5, fy = (M[3] * xx + M[4] * yy + M[5]) / wz - 0.5;
      fx = fx < 0 ? 0 : fx > maxX ? maxX : fx; fy = fy < 0 ? 0 : fy > maxY ? maxY : fy;
      const x0 = fx | 0, y0 = fy | 0, x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const ax = fx - x0, ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const di = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * ax;
        const bot = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * ax;
        d[di + k] = top + (bot - top) * ay;
      }
      d[di + 3] = 255;
    }
  }
  const n = W * H, gray = toGray(d, n), lut = levelsLut(gray, mode);
  if (mode === 'bw') {
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = lut[gray[i]]; d[j] = d[j + 1] = d[j + 2] = v; }
  } else {
    for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]]; }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Full-size page -> { bytes (JPEG), width, height }. Decodes the ORIGINAL, scales it to ~3000px,
// and crops from that, so a 12 MP photo gives a ~1275-1700px wide page. Called one page at a time;
// everything it creates is released before it returns.
export async function renderPageJpeg(page, mode, maxW, quality = JPEG_QUALITY) {
  if (!page.orig) return renderFrom(page.blob, page.w, page.h, page.quad, mode, maxW, quality);
  const plan = planSave(page.ow, page.oh, page.w, page.h, page.quad, { maxW });
  const bmp = await decodeBitmap(page.orig, { width: page.ow, height: page.oh });
  try {
    const { width: sw, height: sh } = plan.source;
    return await renderFrom(bmp, sw, sh, plan.quad, mode, maxW, quality); // warp draws it at sw x sh
  } finally { release(bmp); }
}

async function renderFrom(src, sw, sh, quad, mode, maxW, quality = JPEG_QUALITY) {
  const bmp = src instanceof Blob ? await bitmapOf(src) : null;
  let out;
  try {
    out = warp(bmp || src, sw, sh, quad, mode, maxW);
    const blob = await toBlob(out, 'image/jpeg', quality);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: out.width, height: out.height };
  } finally { release(bmp, out); }
}

// Thumbnail from a ~300px-wide copy. Returns an object URL (caller revokes it).
export async function renderThumbUrl(page, mode) {
  const k = Math.min(1, THUMB_W / page.w);
  const tw = Math.max(1, Math.round(page.w * k)), th = Math.max(1, Math.round(page.h * k));
  const bmp = await bitmapOf(page.blob, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' });
  let out;
  try {
    out = warp(bmp, tw, th, page.quad.map((p) => ({ x: p.x * k, y: p.y * k })), mode, THUMB_W);
    return URL.createObjectURL(await toBlob(out, 'image/jpeg', 0.6));
  } finally { release(bmp, out); }
}
