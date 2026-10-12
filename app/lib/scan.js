// Pure helpers for the BOL/POD scanner (no DOM). Unit-tested in tests/js/scan.test.mjs.

export const PAGE_MAX_WIDTH = 1700; // px per PDF page (~200 dpi on letter width)
export const JPEG_QUALITY = 0.7;
export const PDF_PAGE_WIDTH_PT = 612; // US letter width in points

// ---- page list ----
export function movePage(pages, from, to) {
  if (from === to || from < 0 || from >= pages.length) return pages.slice();
  const t = Math.max(0, Math.min(pages.length - 1, to));
  const out = pages.slice();
  const [p] = out.splice(from, 1);
  out.splice(t, 0, p);
  return out;
}
export function removePage(pages, i) { return pages.filter((_, k) => k !== i); }
export function replacePage(pages, i, page) { return pages.map((p, k) => (k === i ? page : p)); }

// ---- sizing ----
// Scale (w, h) so width <= maxW, keeping the aspect ratio. Never upscales. Integer result.
export function fitWidth(w, h, maxW = PAGE_MAX_WIDTH) {
  if (!(w > 0 && h > 0)) throw new Error('bad size');
  const k = Math.min(1, maxW / w);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
// Same, but bounding the long side (used to cap camera photos before processing).
export function fitLongSide(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
// PDF page size in points for an image: fixed letter width, height from the aspect ratio.
export function pdfPageSize(imgW, imgH) {
  return { width: PDF_PAGE_WIDTH_PT, height: Math.round((PDF_PAGE_WIDTH_PT * imgH / imgW) * 100) / 100 };
}
// Output size of a perspective crop from its corners (tl, tr, br, bl), capped at maxW wide.
export function warpSize(q, maxW = PAGE_MAX_WIDTH) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = Math.max(d(q[0], q[1]), d(q[3], q[2]));
  const h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  return fitWidth(Math.max(1, w), Math.max(1, h), maxW);
}

// ---- geometry ----
// Order 4 points as top-left, top-right, bottom-right, bottom-left.
export function orderCorners(pts) {
  const bySum = pts.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = pts.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}
export function fullFrame(w, h) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}
// Shoelace area of a quad.
export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

// Homography H (3x3, row-major, h33 = 1) mapping src[i] -> dst[i] for 4 point pairs.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}
function solve(A, b) { // Gaussian elimination with partial pivoting (8x8)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('degenerate quad');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// ---- edge detection (lightweight, no OpenCV) ----
// gray: Uint8 luminance array (w*h), small (~500px). Paper is usually the largest bright region:
// threshold with Otsu, keep the largest 4-connected bright component, take its extreme corners
// (min/max of x+y and y-x). Returns null when nothing plausible is found (caller keeps full frame).
export function detectQuad(gray, w, h, { minAreaFrac = 0.15 } = {}) {
  const t = otsu(gray);
  const n = w * h, label = new Int32Array(n), stack = new Int32Array(n);
  let best = { size: 0, id: 0 }, id = 0;
  for (let i = 0; i < n; i++) {
    if (label[i] || gray[i] <= t) continue;
    id++; let sp = 0, size = 0; stack[sp++] = i; label[i] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !label[p - 1] && gray[p - 1] > t) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !label[p + 1] && gray[p + 1] > t) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && !label[p - w] && gray[p - w] > t) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && !label[p + w] && gray[p + w] > t) { label[p + w] = id; stack[sp++] = p + w; }
    }
    if (size > best.size) best = { size, id };
  }
  if (best.size < n * minAreaFrac) return null;
  // Region fills (nearly) the whole frame: no visible background, cropping wouldn't help.
  if (best.size > n * 0.97) return null;
  let tl, tr, br, bl, mins = Infinity, maxs = -Infinity, mind = Infinity, maxd = -Infinity;
  for (let i = 0; i < n; i++) {
    if (label[i] !== best.id) continue;
    const x = i % w, y = (i / w) | 0, s = x + y, d = y - x;
    if (s < mins) { mins = s; tl = { x, y }; }
    if (s > maxs) { maxs = s; br = { x: x + 1, y: y + 1 }; }
    if (d < mind) { mind = d; tr = { x: x + 1, y }; }
    if (d > maxd) { maxd = d; bl = { x, y: y + 1 }; }
  }
  const q = [tl, tr, br, bl];
  if (quadArea(q) < n * minAreaFrac) return null;
  return q;
}
export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length; let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

// ---- cleanup ----
// Levels from the 2nd/98th luminance percentiles. Returns a 256-entry lookup table.
export function levelsLut(gray, mode = 'bw') {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const pct = (p) => { let c = 0; const lim = gray.length * p; for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= lim) return i; } return 255; };
  const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.98));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = (i - lo) / (hi - lo);
    v = Math.min(1, Math.max(0, v));
    // B&W: steep S-curve so paper goes white and ink goes black, without hard aliasing.
    if (mode === 'bw') v = v < 0.5 ? 0.5 * Math.pow(2 * v, 2.2) : 1 - 0.5 * Math.pow(2 * (1 - v), 2.2);
    lut[i] = Math.round(v * 255);
  }
  return lut;
}

// ---- PDF ----
// pages: [{ bytes: Uint8Array (JPEG), width, height }] in order. PDFDocument from pdf-lib is passed in
// so this stays testable without a bundler. Returns the PDF bytes.
export async function buildPdf(pages, PDFDocument, { title = 'Scanned document' } = {}) {
  if (!pages.length) throw new Error('no pages');
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setProducer('PowerHaul TMS'); doc.setCreator('PowerHaul TMS scanner');
  for (const p of pages) {
    const img = await doc.embedJpg(p.bytes);
    const { width, height } = pdfPageSize(p.width, p.height);
    const page = doc.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  return doc.save();
}

export function scanFileName(docType, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${(docType || 'scan').toUpperCase()}_${stamp}.pdf`;
}
