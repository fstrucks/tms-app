'use client';
// Browser-only image steps for the scanner (canvas). Pure math lives in app/lib/scan.js.
import { fitLongSide, detectQuad, fullFrame, homography, applyH, warpSize, levelsLut, JPEG_QUALITY } from '../../lib/scan';

const SOURCE_MAX = 2400; // cap camera photos (12MP+) before any processing, to save memory
const DETECT_MAX = 400;  // edge detection runs on a small copy

function isHeic(file) {
  const t = (file.type || '').toLowerCase();
  return t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(file.name || '');
}

export function rejectReason(file) {
  const t = (file.type || '').toLowerCase();
  if (t.includes('svg') || /\.svg$/i.test(file.name || '')) return 'SVG images are not supported.';
  if (t && !t.startsWith('image/')) return 'Pick a photo (JPEG, PNG, WebP or HEIC).';
  return null;
}

async function decode(file) {
  let blob = file;
  if (isHeic(file)) {
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    blob = Array.isArray(out) ? out[0] : out;
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode(); // EXIF orientation is applied by the browser when drawing
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toGray(data, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}

// File -> { source: canvas (<= 2400px), quad (source px), detected: boolean }
export async function loadPhoto(file) {
  const img = await decode(file);
  const { width, height } = fitLongSide(img.naturalWidth, img.naturalHeight, SOURCE_MAX);
  const source = document.createElement('canvas');
  source.width = width; source.height = height;
  source.getContext('2d').drawImage(img, 0, 0, width, height);
  return { source, ...detect(source) };
}

export function detect(source) {
  const { width: dw, height: dh } = fitLongSide(source.width, source.height, DETECT_MAX);
  const c = document.createElement('canvas'); c.width = dw; c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, dw, dh);
  let q = null;
  try { q = detectQuad(toGray(ctx.getImageData(0, 0, dw, dh).data, dw * dh), dw, dh); } catch { q = null; }
  if (!q) return { quad: fullFrame(source.width, source.height), detected: false };
  const kx = source.width / dw, ky = source.height / dh;
  return { quad: q.map((p) => ({ x: p.x * kx, y: p.y * ky })), detected: true };
}

// Perspective crop + cleanup. mode 'bw' (grayscale, strong levels) or 'color' (auto levels).
export function renderPage(source, quad, mode, maxW) {
  const { width: W, height: H } = warpSize(quad, maxW);
  const sctx = source.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, source.width, source.height).data;
  const sw = source.width, sh = source.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H), d = img.data;
  const Hm = homography(fullFrame(W, H), quad); // output px -> source px
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyH(Hm, x + 0.5, y + 0.5);
      const sx = Math.min(sw - 1, Math.max(0, p.x | 0)), sy = Math.min(sh - 1, Math.max(0, p.y | 0));
      const si = (sy * sw + sx) * 4, di = (y * W + x) * 4;
      d[di] = src[si]; d[di + 1] = src[si + 1]; d[di + 2] = src[si + 2]; d[di + 3] = 255;
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

export function canvasToJpeg(canvas, quality = JPEG_QUALITY) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality));
}
