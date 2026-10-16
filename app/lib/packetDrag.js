// Pure geometry for dragging/resizing a field box on the page. Boxes are [x0,y0,x1,y1] in page px@200dpi.
export const MIN_W = 24, MIN_H = 16;
export const TAP_SLOP = 6; // display px; less movement than this is a tap, not a drag
export function dragBox(box, mode, dx, dy, pageW, pageH) {
  let [x0, y0, x1, y1] = box.map(Number);
  if (mode === 'resize') {
    x1 = Math.min(pageW, Math.max(x0 + MIN_W, x1 + dx));
    y1 = Math.min(pageH, Math.max(y0 + MIN_H, y1 + dy));
  } else {
    const w = x1 - x0, h = y1 - y0;
    x0 = Math.max(0, Math.min(x0 + dx, pageW - w)); y0 = Math.max(0, Math.min(y0 + dy, pageH - h));
    x1 = x0 + w; y1 = y0 + h;
  }
  return [x0, y0, x1, y1].map((v) => Math.round(v));
}
export const isTap = (dxPx, dyPx) => Math.hypot(dxPx, dyPx) < TAP_SLOP;

// Page px per CSS px from the page as actually rendered (getBoundingClientRect): pointer clientX/Y deltas
// are CSS px, boxes are page px@200dpi. Independent of devicePixelRatio and of stale layout measurements.
export function pxPerCss(el, img) {
  const w = el?.getBoundingClientRect?.().width || 0;
  return w > 0 && img?.w ? img.w / w : 1;
}
// Inch box text → inches, or null while incomplete/invalid ('' '.', '0', >20in).
export function parseInch(v) {
  const t = String(v ?? '').trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t); return n > 0 && n <= 20 ? n : null;
}
