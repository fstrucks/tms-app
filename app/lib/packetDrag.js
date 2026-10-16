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
