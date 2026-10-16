// D3: pdf-lib overlay fill. Draws mapped values into detected boxes on the original pages.
// Boxes are in raster pixels (top-left origin) at `dpi`; converted to PDF points (bottom-left).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export function boxToPdf([x0, y0, x1, y1], pageHeightPt, dpi = 200) {
  const s = 72 / dpi;
  return { x: x0 * s, y: pageHeightPt - y1 * s, w: (x1 - x0) * s, h: (y1 - y0) * s };
}
export function fitSize(font, text, maxW, start = 11, min = 6) {
  let size = start;
  while (size > min && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  return size;
}
// fields: [{page, kind, box, value}]; signature fields are skipped here (Sign all is PR E).
// Refuses unconfirmed bank fields so they can't be filled without the user's OK.
export async function fillPacket(pdfBytes, fields, { dpi = 200 } = {}) {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  let drawn = 0;
  for (const f of fields) {
    if (f.needs_confirm && !f.confirmed) throw new Error(`Field ${f.id} needs user confirmation before filling`);
    const p = pages[(f.page || 1) - 1];
    if (!p || f.kind === 'signature' || f.value == null || f.value === '' || f.value === false) continue;
    const b = boxToPdf(f.box, p.getHeight(), dpi);
    const text = f.kind === 'checkbox' ? 'X' : String(f.value);
    const size = f.kind === 'checkbox' ? Math.min(b.h, 12) : fitSize(font, text, b.w - 2);
    p.drawText(text, { x: b.x + 1, y: b.y + 2, size, font, color: rgb(0, 0, 0.55) });
    drawn++;
  }
  return { bytes: await doc.save(), drawn };
}
