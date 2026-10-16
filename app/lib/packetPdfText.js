// Server: read a digital PDF's text layer + simple vector shapes (pdfjs) into detector input.
// Output coords are raster px at `dpi`, top-left origin, matching packetDetect/packetFill.
// Scans (no text layer) return hasText:false → manual mapping (OCR later).
export const MAX_PAGES = 15;
const MIN_CHARS = 20; // fewer text chars than this across the doc = treat as a scan

// Serverless: pdfjs's Node "fake worker" does a dynamic import of ./pdf.worker.mjs that Vercel's file tracing
// can't see, so the worker file was missing in the deployed function and every getDocument() failed.
// Importing the worker ourselves (a static specifier, so it's traced) and exposing it as globalThis.pdfjsWorker
// makes pdfjs use it in-process. No canvas/DOM is needed: we only read text + operator lists.
let libP = null;
export function loadPdfjs() {
  if (!libP) libP = (async () => {
    if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })().catch((e) => { libP = null; throw e; });
  return libP;
}

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Split a text item into words with proportional widths; runs of 3+ underscores become blank lines.
export function itemToWords(str, x, yTop, w, h) {
  const words = [], lines = [];
  const n = str.length || 1, cw = w / n;
  const re = /_{3,}|[^\s_]+(?:_{1,2}[^\s_]+)*/g; let m;
  while ((m = re.exec(str))) {
    const left = x + m.index * cw, width = m[0].length * cw;
    if (m[0][0] === '_' && /^_+$/.test(m[0])) lines.push({ x: left, y: yTop + h, w: width, h: 2 });
    else words.push({ text: m[0], left, top: yTop, width, height: h, conf: 100 });
  }
  return { words, lines };
}

export async function extractPdf(bytes, { dpi = 200, maxPages = MAX_PAGES, deadline = Infinity, pdfjs } = {}) {
  const lib = pdfjs || await loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const s = dpi / 72, pages = []; let chars = 0, truncated = false;
  const total = doc.numPages;
  for (let p = 1; p <= Math.min(total, maxPages); p++) {
    if (Date.now() > deadline) { truncated = true; break; }
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const H = vp.height;
    const words = [], lines = [], squares = [];
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      chars += it.str.replace(/\s/g, '').length;
      const [, , c, d, e, f] = it.transform;
      const fh = Math.hypot(c, d) || it.height || 10;
      const r = itemToWords(it.str, e * s, (H - f - fh * 0.8) * s, it.width * s, fh * s);
      words.push(...r.words); lines.push(...r.lines);
    }
    // Vector shapes: rectangles (thin = rule line, small square = checkbox) and horizontal line segments.
    const ops = await page.getOperatorList(); const O = lib.OPS;
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === O.save) stack.push(ctm); else if (fn === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.constructPath) {
        const [sub, co] = a; let k = 0, cur = null; let poly = [];
        const flush = () => {
          if (poly.length >= 4) {
            const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
            const L = Math.min(...xs) * s, T = (H - Math.max(...ys)) * s, W = (Math.max(...xs) - Math.min(...xs)) * s, Hh = (Math.max(...ys) - Math.min(...ys)) * s;
            if (W >= 14 && W <= 34 && Math.abs(W - Hh) <= 4) squares.push({ x: L, y: T, w: W, h: Hh, ink: 0 });
            else if (Hh <= 6 && W >= 40) lines.push({ x: L, y: T + Hh, w: W, h: Math.max(1, Hh) });
          }
          poly = [];
        };
        for (const op of sub) {
          if (op === O.rectangle) {
            const [x, y, w, h] = co.slice(k, k + 4); k += 4;
            const [x0, y0] = apply(ctm, x, y), [x1, y1] = apply(ctm, x + w, y + h);
            const L = Math.min(x0, x1) * s, T = (H - Math.max(y0, y1)) * s, W = Math.abs(x1 - x0) * s, Hh = Math.abs(y1 - y0) * s;
            if (Hh <= 6 && W >= 40) lines.push({ x: L, y: T + Hh, w: W, h: Math.max(1, Hh) });
            else if (W >= 14 && W <= 34 && Math.abs(W - Hh) <= 4) squares.push({ x: L, y: T, w: W, h: Hh, ink: 0 });
          } else if (op === O.moveTo) { flush(); cur = apply(ctm, co[k], co[k + 1]); poly = [cur]; k += 2; }
          else if (op === O.lineTo) {
            const nx = apply(ctm, co[k], co[k + 1]); k += 2;
            if (cur && Math.abs(nx[1] - cur[1]) < 0.5 && Math.abs(nx[0] - cur[0]) * s >= 40) lines.push({ x: Math.min(cur[0], nx[0]) * s, y: (H - cur[1]) * s, w: Math.abs(nx[0] - cur[0]) * s, h: 2 });
            cur = nx; poly.push(nx);
          } else if (op === O.closePath) flush(); else if (op === O.curveTo) k += 6; else if (op === O.curveTo2 || op === O.curveTo3) k += 4;
        }
      }
    }
    pages.push({ page: p, size: [vp.width * s, H * s], sizePt: [vp.width, H], words, lines, squares });
    page.cleanup();
  }
  await doc.destroy();
  return { pages, pageCount: total, hasText: chars >= MIN_CHARS, truncated: truncated || total > maxPages };
}
