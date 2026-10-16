// D1: local field detection (pure JS port of the on-box OpenCV detector's placement rules).
// Input per page: words [{text,left,top,width,height,conf}], horizontal line segments [{x,y,w,h}],
// candidate squares [{x,y,w,h,ink}] from the rasterizer. Output: fields [{id,page,kind,label,box}].
// No network, no secrets. Rasterizing (lines/squares/words) is a separate adapter (open decision).
const right = (r) => r.left + r.width;

export function detectPage({ page, size: [W] = [0], words = [], lines = [], squares = [] }) {
  const ws = words.filter((r) => String(r.text || '').trim() && (r.conf ?? 100) > 30);
  const fields = [];
  const kept = [];
  for (const l of lines) {
    if (l.h > 6 || (W && l.w > 0.9 * W)) continue;
    if (kept.some((k) => Math.abs(k.x - l.x) < 6 && Math.abs(k.y - l.y) < 6 && Math.abs(k.w - l.w) < 10)) continue; // same rule drawn twice
    kept.push(l);
    // Skip text underlines: words sitting on the line covering most of its width.
    const cov = ws.filter((r) => Math.abs(r.top + r.height - l.y) < 6 && r.left >= l.x - 5 && right(r) <= l.x + l.w + 5).reduce((s, r) => s + r.width, 0);
    if (cov > 0.6 * l.w) continue;
    const lab = ws.filter((r) => Math.abs(r.top + r.height / 2 - (l.y - 10)) < 14 && right(r) < l.x + 5 && r.left > l.x - 300)
      .sort((a, b) => a.left - b.left).map((r) => r.text);
    const label = lab.slice(-5).join(' ');
    const kind = /sign/i.test(label) ? 'signature' : /\bdate\b/i.test(label) ? 'date' : 'text';
    fields.push({ kind, label, box: [l.x, l.y - 28, l.x + l.w, l.y + 2] });
  }
  const seen = [];
  for (const s of squares) {
    if (s.w < 14 || s.w > 34 || s.h < 14 || s.h > 34 || Math.abs(s.w - s.h) > 4 || (s.ink ?? 0) >= 0.25) continue;
    if (seen.some((p) => Math.abs(p.x - s.x) < 6 && Math.abs(p.y - s.y) < 6)) continue;
    seen.push(s);
    const lab = ws.filter((r) => Math.abs(r.top + r.height / 2 - (s.y + s.h / 2)) < 12 && r.left - s.x > 0 && r.left - s.x < 250)
      .sort((a, b) => a.left - b.left).slice(0, 5).map((r) => r.text);
    fields.push({ kind: 'checkbox', label: lab.join(' '), box: [s.x, s.y, s.x + s.w, s.y + s.h] });
  }
  fields.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  return fields.map((f, i) => ({ id: `p${page}-f${i}`, page, ...f }));
}

export const detectPacket = (pages) => pages.flatMap(detectPage);
